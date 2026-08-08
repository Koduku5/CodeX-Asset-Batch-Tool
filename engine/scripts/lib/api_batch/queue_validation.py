"""Pure structural validation for API and redraw queues."""

from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
from typing import Callable

from api_batch.file_runtime import (
    canonical_fingerprint,
    is_within,
    json_fingerprint,
    normalize_prompt_text,
    read_json,
    reject_reparse_segments,
    require_stable_real_directory,
    set_directory_redraw_output_root,
)
from api_batch.progress_store import clean_text


def valid_api_prompt_batch(queue: dict, image_sheet_order: tuple[str, ...]) -> bool:
    prompt_batch = queue.get("apiPromptBatch")
    return (
        isinstance(prompt_batch, dict)
        and set(prompt_batch) == {"version", "confirmedAt", "bySheet"}
        and prompt_batch.get("version") == 2
        and bool(clean_text(prompt_batch.get("confirmedAt")))
        and isinstance(prompt_batch.get("bySheet"), dict)
        and set(prompt_batch["bySheet"]) == set(image_sheet_order)
        and all(isinstance(prompt_batch["bySheet"].get(name), str) for name in image_sheet_order)
    )


def queue_operation(queue: dict) -> str:
    operation = clean_text(queue.get("operation")) or "generate"
    if operation not in {"generate", "reference_redraw", "directory_redraw"}:
        raise SystemExit(f"出图队列 operation 无效：{operation}")
    return operation


def validate_reference_redraw_structure(
    queue: dict,
    *,
    image_output_root: Path,
    resolve_skill_file: Callable[[str, str], Path],
    resolve_output: Callable[[str], Path],
) -> None:
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

    redraw_base_root = (image_output_root / "API重绘").resolve()
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
        if not is_within(reference_path, image_output_root) or is_within(
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


def validate_directory_redraw_structure(
    queue: dict,
    *,
    skill_root: Path,
) -> tuple[Path, Path]:
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
    resolved_skill_root = skill_root.resolve()
    if (
        is_within(source_root, resolved_skill_root)
        or is_within(resolved_skill_root, source_root)
        or is_within(output_root, resolved_skill_root)
        or is_within(resolved_skill_root, output_root)
    ):
        raise SystemExit("原图和结果目录必须与 Skill 项目目录完全分离")
    if is_within(source_root, output_root) or is_within(output_root, source_root):
        raise SystemExit("原图目录与结果目录不能相同或互相嵌套")
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
    return source_root, output_root


def validate_new_api_queue_items(
    queue: dict,
    *,
    image_sheet_order: tuple[str, ...],
    resolve_skill_file: Callable[[str, str], Path],
) -> None:
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
        or routes.get("sheetOrder") != list(image_sheet_order)
        or not isinstance(routes.get("routes"), dict)
        or set(routes["routes"]) != set(image_sheet_order)
    ):
        raise SystemExit("API 出图路由结构无效")

    route_fingerprints = {}
    for sheet_name in image_sheet_order:
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
        if sheet_name not in image_sheet_order or not isinstance(item.get("productionNotes"), str):
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
