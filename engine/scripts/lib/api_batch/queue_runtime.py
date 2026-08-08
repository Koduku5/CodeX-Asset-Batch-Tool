"""Queue validation, path resolution, freshness, and execution fingerprints."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath

from api_batch.file_runtime import (
    cached_file_sha256,
    canonical_fingerprint,
    is_within,
    json_fingerprint,
    normalize_prompt_text,
    read_json,
    reject_reparse_segments,
    require_stable_real_directory,
    resolve_output,
    set_directory_redraw_output_root,
)
from api_batch.image_validation import valid_reference_image
from api_batch.progress_store import clean_text


IMAGE_SHEET_ORDER: tuple[str, ...] = ()
QUEUE_VERSION = 0
DIRECTORY_REDRAW_MODE = False
ONLY_KEY = ""
QUEUE_PATH = Path(".")
PROGRESS_PATH = Path(".")
SKILL_ROOT = Path(".")
CACHE_DIR = Path(".")
IMAGE_OUTPUT_ROOT = Path(".")
IMAGE_OUTPUT_ROOT_PATH = Path(".")
BASE_URL = ""
PROJECT_ID = ""
MODEL_ID = ""
DEFAULT_ASPECT_RATIO = ""
DEFAULT_IMAGE_SIZE = ""
DIRECTORY_REDRAW_SOURCE_ROOT: Path | None = None
DIRECTORY_REDRAW_OUTPUT_ROOT: Path | None = None


def configure_queue_runtime(
    *,
    image_sheet_order: tuple[str, ...],
    queue_version: int,
    directory_redraw_mode: bool,
    only_key: str,
    queue_path: Path,
    progress_path: Path,
    skill_root: Path,
    cache_dir: Path,
    image_output_root: Path,
    image_output_root_path: Path,
    base_url: str,
    project_id: str,
    model_id: str,
    default_aspect_ratio: str,
    default_image_size: str,
) -> None:
    """Configure immutable inputs shared by queue validation operations."""
    global IMAGE_SHEET_ORDER, QUEUE_VERSION, DIRECTORY_REDRAW_MODE, ONLY_KEY
    global QUEUE_PATH, PROGRESS_PATH, SKILL_ROOT, CACHE_DIR
    global IMAGE_OUTPUT_ROOT, IMAGE_OUTPUT_ROOT_PATH
    global BASE_URL, PROJECT_ID, MODEL_ID, DEFAULT_ASPECT_RATIO, DEFAULT_IMAGE_SIZE
    global DIRECTORY_REDRAW_SOURCE_ROOT, DIRECTORY_REDRAW_OUTPUT_ROOT

    IMAGE_SHEET_ORDER = image_sheet_order
    QUEUE_VERSION = queue_version
    DIRECTORY_REDRAW_MODE = directory_redraw_mode
    ONLY_KEY = only_key
    QUEUE_PATH = queue_path
    PROGRESS_PATH = progress_path
    SKILL_ROOT = skill_root
    CACHE_DIR = cache_dir
    IMAGE_OUTPUT_ROOT = image_output_root
    IMAGE_OUTPUT_ROOT_PATH = image_output_root_path
    BASE_URL = base_url
    PROJECT_ID = project_id
    MODEL_ID = model_id
    DEFAULT_ASPECT_RATIO = default_aspect_ratio
    DEFAULT_IMAGE_SIZE = default_image_size
    DIRECTORY_REDRAW_SOURCE_ROOT = None
    DIRECTORY_REDRAW_OUTPUT_ROOT = None



def valid_api_prompt_batch(queue: dict) -> bool:
    prompt_batch = queue.get("apiPromptBatch")
    return (
        isinstance(prompt_batch, dict)
        and set(prompt_batch) == {"version", "confirmedAt", "bySheet"}
        and prompt_batch.get("version") == 2
        and bool(clean_text(prompt_batch.get("confirmedAt")))
        and isinstance(prompt_batch.get("bySheet"), dict)
        and set(prompt_batch["bySheet"]) == set(IMAGE_SHEET_ORDER)
        and all(isinstance(prompt_batch["bySheet"].get(name), str) for name in IMAGE_SHEET_ORDER)
    )


def queue_operation(queue: dict) -> str:
    operation = clean_text(queue.get("operation")) or "generate"
    if operation not in {"generate", "reference_redraw", "directory_redraw"}:
        raise SystemExit(f"出图队列 operation 无效：{operation}")
    return operation


def validate_reference_redraw_structure(queue: dict) -> None:
    metadata = queue.get("referenceRedraw")
    if not isinstance(metadata, dict) or set(metadata) != {
        "version",
        "batchId",
        "sourceRoot",
        "outputRoot",
        "candidateCount",
        "sourceCount",
        "skippedMissingSources",
    }:
        raise SystemExit("API 重绘队列缺少有效的 referenceRedraw 元数据")
    batch_id = clean_text(metadata.get("batchId"))
    if (
        metadata.get("version") != 1
        or not batch_id.startswith("batch-")
        or len(batch_id) != 23
        or not batch_id[6:].isdigit()
        or metadata.get("sourceRoot") != "输出/资产图"
        or metadata.get("outputRoot") != f"输出/资产图/API重绘/{batch_id}"
        or not isinstance(metadata.get("candidateCount"), int)
        or not isinstance(metadata.get("sourceCount"), int)
        or not isinstance(metadata.get("skippedMissingSources"), list)
        or metadata["sourceCount"] != len(queue.get("items", []))
        or metadata["candidateCount"]
        != metadata["sourceCount"] + len(metadata["skippedMissingSources"])
    ):
        raise SystemExit("API 重绘队列 referenceRedraw 元数据无效")
    if not queue.get("items"):
        raise SystemExit("API 重绘队列没有可执行任务")

    redraw_base_root = (IMAGE_OUTPUT_ROOT / "API重绘").resolve()
    redraw_root = (redraw_base_root / batch_id).resolve()
    for item in queue["items"]:
        references = item.get("references")
        snapshots = item.get("referenceSnapshots")
        if item.get("operation") != "reference_redraw":
            raise SystemExit(f"API 重绘任务缺少 operation：{item.get('key', '未知任务')}")
        if not isinstance(references, list) or len(references) != 1:
            raise SystemExit(f"API 重绘任务必须且只能绑定一张原图：{item.get('key', '未知任务')}")
        if not isinstance(snapshots, list) or len(snapshots) != 1:
            raise SystemExit(f"API 重绘任务缺少原图快照：{item.get('key', '未知任务')}")
        snapshot = snapshots[0]
        if (
            not isinstance(snapshot, dict)
            or set(snapshot) != {"path", "size", "sha256"}
            or snapshot.get("path") != references[0]
            or not isinstance(snapshot.get("size"), int)
            or snapshot["size"] <= 0
            or snapshot["size"] > 20 * 1024 * 1024
            or not isinstance(snapshot.get("sha256"), str)
            or len(snapshot["sha256"]) != 64
        ):
            raise SystemExit(f"API 重绘任务原图快照无效：{item.get('key', '未知任务')}")
        try:
            reference_path = resolve_skill_file(references[0], "reference")
            output_path = resolve_output(item.get("outputPath", ""))
        except ValueError as error:
            raise SystemExit(str(error)) from error
        if not is_within(reference_path, IMAGE_OUTPUT_ROOT) or is_within(
            reference_path, redraw_base_root
        ):
            raise SystemExit(f"API 重绘原图必须位于标准资产图分类目录：{references[0]}")
        if not is_within(output_path, redraw_root):
            raise SystemExit(f"API 重绘结果必须写入 输出/资产图/API重绘：{item.get('outputPath')}")
        if os.path.normcase(str(reference_path)) == os.path.normcase(str(output_path)):
            raise SystemExit(f"API 重绘结果禁止覆盖原图：{references[0]}")


def is_sha256(value) -> bool:
    text = clean_text(value).lower()
    return len(text) == 64 and all(character in "0123456789abcdef" for character in text)


def safe_relative_parts(value: str, label: str) -> tuple[str, ...]:
    text = str(value or "").replace("\\", "/")
    pure = PurePosixPath(text)
    if (
        not text
        or pure.is_absolute()
        or str(pure) != text
        or any(part in {"", ".", ".."} or ":" in part for part in pure.parts)
    ):
        raise SystemExit(f"{label}不是安全相对路径：{value}")
    return pure.parts


def validate_directory_redraw_structure(queue: dict) -> None:
    global DIRECTORY_REDRAW_SOURCE_ROOT, DIRECTORY_REDRAW_OUTPUT_ROOT

    required_fields = {
        "version",
        "operation",
        "batchId",
        "builtAt",
        "sourceRoot",
        "outputRoot",
        "prompt",
        "promptFingerprint",
        "recursive",
        "candidateCount",
        "sourceCount",
        "skipped",
        "items",
        "queueFingerprint",
    }
    if set(queue) != required_fields:
        raise SystemExit("文件夹批量重绘队列字段无效，请重新建立")
    batch_id = clean_text(queue.get("batchId"))
    prompt = normalize_prompt_text(queue.get("prompt"))
    if (
        queue.get("version") != 1
        or queue.get("operation") != "directory_redraw"
        or not batch_id
        or not clean_text(queue.get("builtAt"))
        or not prompt
        or queue.get("prompt") != prompt
        or not is_sha256(queue.get("promptFingerprint"))
        or queue.get("recursive") is not True
        or not isinstance(queue.get("candidateCount"), int)
        or not isinstance(queue.get("sourceCount"), int)
        or not isinstance(queue.get("skipped"), list)
        or not isinstance(queue.get("items"), list)
        or not is_sha256(queue.get("queueFingerprint"))
        or queue["sourceCount"] != len(queue["items"])
        or queue["candidateCount"] != queue["sourceCount"] + len(queue["skipped"])
    ):
        raise SystemExit("文件夹批量重绘队列结构无效，请重新建立")
    if not queue["items"]:
        raise SystemExit("文件夹批量重绘队列没有可执行图片")

    source_root_value = Path(clean_text(queue.get("sourceRoot")))
    output_root_value = Path(clean_text(queue.get("outputRoot")))
    if not source_root_value.is_absolute() or not output_root_value.is_absolute():
        raise SystemExit("文件夹批量重绘的原图与结果目录必须是绝对路径")
    source_root = require_stable_real_directory(source_root_value, "文件夹批量重绘原图目录")
    output_root = require_stable_real_directory(output_root_value, "文件夹批量重绘结果目录")
    if source_root == Path(source_root.anchor) or output_root == Path(output_root.anchor):
        raise SystemExit("禁止把磁盘根目录作为批量重绘目录")
    if not source_root.is_dir() or not output_root.is_dir():
        raise SystemExit("文件夹批量重绘的原图或结果目录不存在")
    skill_root = SKILL_ROOT.resolve()
    if (
        is_within(source_root, skill_root)
        or is_within(skill_root, source_root)
        or is_within(output_root, skill_root)
        or is_within(skill_root, output_root)
    ):
        raise SystemExit("原图和结果目录必须与 Skill 项目目录完全分离")
    if is_within(source_root, output_root) or is_within(output_root, source_root):
        raise SystemExit("原图目录与结果目录不能相同或互相嵌套")
    DIRECTORY_REDRAW_SOURCE_ROOT = source_root
    DIRECTORY_REDRAW_OUTPUT_ROOT = output_root
    set_directory_redraw_output_root(output_root)

    if clean_text(queue.get("promptFingerprint")) != canonical_fingerprint({"prompt": prompt}):
        raise SystemExit("文件夹批量重绘提示词指纹无效")

    keys = set()
    for index, item in enumerate(queue["items"], start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"文件夹批量重绘队列第 {index} 项不是对象")
        required_item_fields = {
            "key",
            "sourceRelativePath",
            "outputRelativePath",
            "sourceSnapshot",
            "prompt",
            "inputFingerprint",
        }
        if set(item) != required_item_fields:
            raise SystemExit(f"文件夹批量重绘队列第 {index} 项字段无效")
        key = clean_text(item.get("key"))
        if not key or key in keys:
            raise SystemExit(f"文件夹批量重绘任务 key 缺失或重复：{key or index}")
        keys.add(key)
        source_relative = str(item.get("sourceRelativePath") or "")
        output_relative = str(item.get("outputRelativePath") or "")
        source_parts = safe_relative_parts(source_relative, f"任务 {key} 原图路径")
        output_parts = safe_relative_parts(output_relative, f"任务 {key} 输出路径")
        reject_reparse_segments(source_root, source_parts, f"任务 {key} 原图路径")
        reject_reparse_segments(output_root, output_parts, f"任务 {key} 输出路径")
        source_path = (source_root.joinpath(*source_parts)).resolve()
        output_path = (output_root.joinpath(*output_parts)).resolve()
        if not is_within(source_path, source_root) or not is_within(output_path, output_root):
            raise SystemExit(f"文件夹批量重绘任务路径越界：{key}")
        expected_output = PurePosixPath(source_relative).with_suffix(".png").as_posix()
        if output_relative != expected_output:
            raise SystemExit(f"文件夹批量重绘输出路径与原图层级不一致：{key}")
        snapshot = item.get("sourceSnapshot")
        if (
            not isinstance(snapshot, dict)
            or set(snapshot) != {"size", "sha256"}
            or not isinstance(snapshot.get("size"), int)
            or snapshot["size"] <= 0
            or snapshot["size"] > 20 * 1024 * 1024
            or not is_sha256(snapshot.get("sha256"))
            or normalize_prompt_text(item.get("prompt")) != prompt
        ):
            raise SystemExit(f"文件夹批量重绘任务快照或提示词无效：{key}")
        expected_input = canonical_fingerprint(
            {
                "operation": "directory_redraw",
                "outputRelativePath": output_relative,
                "promptFingerprint": queue["promptFingerprint"],
                "sourceRelativePath": source_relative,
                "sourceSnapshot": snapshot,
            }
        )
        if clean_text(item.get("inputFingerprint")) != expected_input:
            raise SystemExit(f"文件夹批量重绘任务输入指纹无效：{key}")

        # Normalize the dedicated queue item into the fields reused by the API executor.
        item["assetName"] = source_relative
        item["outputPath"] = output_relative
        item["references"] = [source_relative]
        item["referenceSnapshots"] = [
            {"path": source_relative, "size": snapshot["size"], "sha256": snapshot["sha256"]}
        ]

    expected_queue_fingerprint = canonical_fingerprint(
        {
            "version": 1,
            "operation": "directory_redraw",
            "sourceRoot": queue["sourceRoot"],
            "outputRoot": queue["outputRoot"],
            "promptFingerprint": queue["promptFingerprint"],
            "recursive": True,
            "items": [
                {
                    "key": item["key"],
                    "sourceRelativePath": item["sourceRelativePath"],
                    "outputRelativePath": item["outputRelativePath"],
                    "sourceSnapshot": item["sourceSnapshot"],
                    "inputFingerprint": item["inputFingerprint"],
                }
                for item in queue["items"]
            ],
            "skipped": queue["skipped"],
        }
    )
    if clean_text(queue.get("queueFingerprint")) != expected_queue_fingerprint:
        raise SystemExit("文件夹批量重绘队列指纹无效")


def validate_new_api_queue_items(queue: dict) -> None:
    prompt_batch = queue["apiPromptBatch"]
    operation = queue_operation(queue)
    try:
        route_path = resolve_skill_file(queue.get("routingConfig", ""), "routingConfig")
        routes = read_json(route_path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"API 出图路由无法读取：{error}") from error
    if (
        not isinstance(routes, dict)
        or routes.get("version") != 1
        or routes.get("sheetOrder") != list(IMAGE_SHEET_ORDER)
        or not isinstance(routes.get("routes"), dict)
        or set(routes["routes"]) != set(IMAGE_SHEET_ORDER)
    ):
        raise SystemExit("API 出图路由结构无效")

    route_fingerprints = {}
    for sheet_name in IMAGE_SHEET_ORDER:
        route = routes["routes"].get(sheet_name)
        if not isinstance(route, dict) or set(route) != {"outputFolder"} or not clean_text(
            route.get("outputFolder")
        ):
            raise SystemExit(f"API 出图路由缺少有效分类：{sheet_name}")
        route_fingerprints[sheet_name] = json_fingerprint(
            {
                "sheetName": sheet_name,
                "route": route,
                "promptTemplate": prompt_batch["bySheet"][sheet_name],
            }
        )

    for item in queue["items"]:
        sheet_name = item.get("sheetName")
        if sheet_name not in IMAGE_SHEET_ORDER or not isinstance(item.get("productionNotes"), str):
            raise SystemExit(f"API 队列项目分类或制作说明无效：{item.get('key', '未知任务')}")
        expected_prompt = "\n\n".join(
            part
            for part in (
                normalize_prompt_text(prompt_batch["bySheet"][sheet_name]),
                normalize_prompt_text(item["productionNotes"]),
            )
            if part
        )
        if not expected_prompt or normalize_prompt_text(item.get("prompt")) != expected_prompt:
            raise SystemExit(f"API 队列 Prompt 与窗口模板快照不一致：{item.get('key', '未知任务')}")

        expected_asset_fingerprint = json_fingerprint(
            {
                "version": 1,
                "sheetName": clean_text(sheet_name),
                "assetId": clean_text(item.get("assetId")),
                "assetName": clean_text(item.get("assetName")),
                "productionNotes": clean_text(item.get("productionNotes")),
                "outputPath": clean_text(item.get("outputPath")),
            }
        )
        if clean_text(item.get("assetFingerprint")) != expected_asset_fingerprint:
            raise SystemExit(f"API 队列资产指纹无效：{item.get('key', '未知任务')}")

        input_payload = {
            "sheetName": sheet_name,
            "assetId": item.get("assetId"),
            "assetName": item.get("assetName"),
            "productionNotes": item.get("productionNotes"),
            "prompt": item.get("prompt"),
            "routeFingerprint": route_fingerprints[sheet_name],
        }
        if operation == "reference_redraw":
            input_payload.update(
                {
                    "operation": "reference_redraw",
                    "references": item.get("references"),
                    "referenceSnapshots": item.get("referenceSnapshots"),
                }
            )
        expected_input_fingerprint = json_fingerprint(input_payload)
        if clean_text(item.get("inputFingerprint")) != expected_input_fingerprint:
            raise SystemExit(f"API 队列输入指纹无效：{item.get('key', '未知任务')}")


def load_queue() -> dict:
    queue = read_json(QUEUE_PATH)
    if not isinstance(queue, dict):
        raise SystemExit("出图队列结构无效，请重新建立出图队列")
    declared_operation = clean_text(queue.get("operation")) or "generate"
    expected_version = 1 if declared_operation == "directory_redraw" else QUEUE_VERSION
    if queue.get("version") != expected_version:
        raise SystemExit("出图队列结构无效，请重新建立出图队列")
    items = queue.get("items")
    if not isinstance(items, list):
        raise SystemExit("出图队列 items 必须是数组")
    operation = queue_operation(queue)
    if DIRECTORY_REDRAW_MODE != (operation == "directory_redraw"):
        raise SystemExit("批量执行模式与队列类型不一致")
    if ONLY_KEY and operation != "generate":
        raise SystemExit("--only-key 只适用于普通 API 资产出图")
    if operation == "directory_redraw":
        validate_directory_redraw_structure(queue)
    else:
        validated_image_root = require_stable_real_directory(
            IMAGE_OUTPUT_ROOT_PATH,
            "资产图输出目录",
        )
        if os.path.normcase(str(validated_image_root)) != os.path.normcase(
            str(IMAGE_OUTPUT_ROOT)
        ):
            raise SystemExit("资产图输出目录真实路径已变化，请重新建立出图队列")
        required_root = (
            "builtAt",
            "routingFingerprint",
            "eligibilityFingerprint",
        )
        if any(not clean_text(queue.get(field)) for field in required_root):
            raise SystemExit("出图队列尚未建立，请先运行 build_image_queue.mjs")
    if operation == "reference_redraw":
        validate_reference_redraw_structure(queue)
    elif operation != "directory_redraw" and "referenceRedraw" in queue:
        raise SystemExit("普通出图队列不应包含 referenceRedraw 元数据")
    prompt_batch_valid = operation != "directory_redraw" and valid_api_prompt_batch(queue)
    if operation != "directory_redraw" and not prompt_batch_valid:
        old_progress = read_json(PROGRESS_PATH, fallback={"items": {}})
        old_items = old_progress.get("items", {}) if isinstance(old_progress, dict) else {}
        queue_items_by_key = {
            clean_text(item.get("key")): item for item in items if isinstance(item, dict)
        }
        has_legacy_api_state = (
            isinstance(old_progress, dict)
            and clean_text(old_progress.get("routingFingerprint"))
            == clean_text(queue.get("routingFingerprint"))
            and isinstance(old_items, dict)
            and any(
                isinstance(state, dict)
                and state.get("backend") == "api"
                and state.get("status") in {"generating", "completed", "failed"}
                and key in queue_items_by_key
                and clean_text(state.get("inputFingerprint"))
                == clean_text(queue_items_by_key[key].get("inputFingerprint"))
                for key, state in old_items.items()
            )
        )
        if not has_legacy_api_state:
            raise SystemExit("API 提示词模板尚未在 API 批量窗口确认")
    keys = set()
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"出图队列第 {index} 项不是对象")
        required_item_fields = (
            ("key", "assetName", "prompt", "outputPath", "inputFingerprint")
            if operation == "directory_redraw"
            else ("key", "assetId", "assetName", "prompt", "outputPath", "inputFingerprint")
        )
        for field in required_item_fields:
            if not clean_text(item.get(field)):
                raise SystemExit(f"出图队列第 {index} 项缺少 {field}")
        if item["key"] in keys:
            raise SystemExit(f"出图队列存在重复 key：{item['key']}")
        keys.add(item["key"])
        resolve_output(item["outputPath"])
        references = item.get("references", [])
        if not isinstance(references, list) or any(not isinstance(value, str) for value in references):
            raise SystemExit(f"任务 {item['key']} references 必须是字符串数组")
    if prompt_batch_valid:
        validate_new_api_queue_items(queue)
    return queue


def resolve_skill_file(relative_path: str, label: str) -> Path:
    if not clean_text(relative_path):
        raise ValueError(f"{label} path is empty")
    target = (SKILL_ROOT / relative_path).resolve()
    try:
        common = Path(os.path.commonpath([str(target), str(SKILL_ROOT)]))
    except ValueError as error:
        raise ValueError(f"{label} path escapes Skill root: {relative_path}") from error
    if os.path.normcase(str(common)) != os.path.normcase(str(SKILL_ROOT)):
        raise ValueError(f"{label} path escapes Skill root: {relative_path}")
    return target


def resolve_reference_file(relative_path: str) -> Path:
    if not DIRECTORY_REDRAW_MODE:
        return resolve_skill_file(relative_path, "reference")
    if DIRECTORY_REDRAW_SOURCE_ROOT is None:
        raise ValueError("directory redraw source root is not configured")
    parts = safe_relative_parts(relative_path, "批量重绘原图路径")
    target = DIRECTORY_REDRAW_SOURCE_ROOT.joinpath(*parts).resolve()
    if not is_within(target, DIRECTORY_REDRAW_SOURCE_ROOT):
        raise ValueError(f"reference path escapes configured source root: {relative_path}")
    return target


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reference_freshness_errors(queue: dict) -> list[str]:
    if queue_operation(queue) not in {"reference_redraw", "directory_redraw"}:
        return []
    errors = []
    for item in queue.get("items", []):
        key = clean_text(item.get("key")) or "未知任务"
        references = item.get("references", [])
        snapshots = item.get("referenceSnapshots", [])
        if len(references) != 1 or len(snapshots) != 1:
            errors.append(f"{key} 原图结构无效")
            continue
        snapshot = snapshots[0]
        try:
            reference = resolve_reference_file(references[0])
            stat = reference.stat()
            if not reference.is_file():
                errors.append(f"{key} 原图不是文件")
                continue
            if stat.st_size != snapshot.get("size"):
                errors.append(f"{key} 原图大小已变化")
                continue
            if cached_file_sha256(reference) != snapshot.get("sha256"):
                errors.append(f"{key} 原图内容已变化")
                continue
            if not valid_reference_image(reference):
                errors.append(f"{key} 原图不是支持的有效图片")
        except (OSError, ValueError) as error:
            errors.append(f"{key} 原图无法读取：{error}")
    return errors


def queue_freshness_errors(queue: dict) -> list[str]:
    if queue_operation(queue) == "directory_redraw":
        errors = reference_freshness_errors(queue)
        if DIRECTORY_REDRAW_OUTPUT_ROOT is None or not DIRECTORY_REDRAW_OUTPUT_ROOT.is_dir():
            errors.append("批量重绘结果目录不存在")
        return list(dict.fromkeys(errors))

    errors = []
    pending_path = CACHE_DIR / "待确认记录.json"
    try:
        if file_sha256(pending_path) != queue.get("eligibilityFingerprint"):
            errors.append("待确认记录已变化")
    except OSError:
        errors.append("待确认记录不存在或无法读取")

    # 旧队列的最终 Prompt 与输出路径已经冻结在每个任务中。它记录的前缀、
    # 风格锚点等外部文件已退出新流程，恢复或重试旧远端任务时不应再依赖它们。
    if valid_api_prompt_batch(queue):
        resources = queue.get("routingResourceFingerprints")
        if not isinstance(resources, dict) or not resources:
            errors.append("队列缺少路由资源指纹")
        else:
            for relative_path, expected in resources.items():
                try:
                    resource = resolve_skill_file(relative_path, "routing resource")
                    if file_sha256(resource) != expected:
                        errors.append(f"出图路由资源已变化：{relative_path}")
                except (OSError, ValueError):
                    errors.append(f"出图路由资源缺失：{relative_path}")

    errors.extend(reference_freshness_errors(queue))
    return list(dict.fromkeys(errors))


def queue_execution_fingerprint(queue: dict) -> str:
    item_payloads = []
    for item in queue.get("items", []):
        payload = {
            "key": item.get("key"),
            "inputFingerprint": item.get("inputFingerprint"),
            "prompt": item.get("prompt"),
            "outputPath": item.get("outputPath"),
        }
        if "references" in item:
            payload["references"] = item.get("references")
        if "referenceSnapshots" in item:
            payload["referenceSnapshots"] = item.get("referenceSnapshots")
        item_payloads.append(payload)
    payload = {
        "builtAt": queue.get("builtAt"),
        "routingFingerprint": queue.get("routingFingerprint"),
        "eligibilityFingerprint": queue.get("eligibilityFingerprint"),
        "apiExecutionFingerprint": api_execution_fingerprint(),
        "items": item_payloads,
    }
    if "operation" in queue:
        payload["operation"] = queue.get("operation")
    if "referenceRedraw" in queue:
        payload["referenceRedraw"] = queue.get("referenceRedraw")
    if queue_operation(queue) == "directory_redraw":
        payload["directoryRedraw"] = {
            field: queue.get(field)
            for field in (
                "batchId",
                "sourceRoot",
                "outputRoot",
                "promptFingerprint",
                "queueFingerprint",
            )
        }
    if isinstance(queue.get("apiPromptBatch"), dict):
        payload["apiPromptBatch"] = queue["apiPromptBatch"]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def api_execution_fingerprint() -> str:
    payload = {
        "baseUrl": BASE_URL,
        "projectId": PROJECT_ID,
        "modelId": MODEL_ID,
        "aspectRatio": DEFAULT_ASPECT_RATIO,
        "imageSize": DEFAULT_IMAGE_SIZE,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
