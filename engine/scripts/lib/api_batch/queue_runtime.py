"""Configured facade for queue validation, freshness, and fingerprints."""

from __future__ import annotations

import os
from pathlib import Path

from api_batch.file_runtime import read_json, require_stable_real_directory, resolve_output
from api_batch.progress_store import clean_text
from api_batch.queue_freshness import (
    api_execution_fingerprint as build_api_execution_fingerprint,
    queue_execution_fingerprint as build_queue_execution_fingerprint,
    queue_freshness_errors as find_queue_freshness_errors,
    resolve_reference_file as resolve_configured_reference_file,
    resolve_skill_file as resolve_configured_skill_file,
)
from api_batch.queue_validation import (
    queue_operation as read_queue_operation,
    valid_api_prompt_batch as has_valid_api_prompt_batch,
    validate_directory_redraw_structure as validate_directory_redraw_queue,
    validate_new_api_queue_items as validate_api_queue_items,
    validate_reference_redraw_structure as validate_reference_redraw_queue,
)


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
    """Configure immutable inputs shared by queue operations."""
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
    return has_valid_api_prompt_batch(queue, IMAGE_SHEET_ORDER)


def queue_operation(queue: dict) -> str:
    return read_queue_operation(queue)


def resolve_skill_file(relative_path: str, label: str) -> Path:
    return resolve_configured_skill_file(relative_path, label, SKILL_ROOT)


def resolve_reference_file(relative_path: str) -> Path:
    return resolve_configured_reference_file(
        relative_path,
        directory_redraw_mode=DIRECTORY_REDRAW_MODE,
        directory_redraw_source_root=DIRECTORY_REDRAW_SOURCE_ROOT,
        skill_root=SKILL_ROOT,
    )


def validate_reference_redraw_structure(queue: dict) -> None:
    validate_reference_redraw_queue(
        queue,
        image_output_root=IMAGE_OUTPUT_ROOT,
        resolve_skill_file=resolve_skill_file,
        resolve_output=resolve_output,
    )


def validate_directory_redraw_structure(queue: dict) -> None:
    global DIRECTORY_REDRAW_SOURCE_ROOT, DIRECTORY_REDRAW_OUTPUT_ROOT
    DIRECTORY_REDRAW_SOURCE_ROOT, DIRECTORY_REDRAW_OUTPUT_ROOT = validate_directory_redraw_queue(
        queue,
        skill_root=SKILL_ROOT,
    )


def validate_new_api_queue_items(queue: dict) -> None:
    validate_api_queue_items(
        queue,
        image_sheet_order=IMAGE_SHEET_ORDER,
        resolve_skill_file=resolve_skill_file,
    )


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


def queue_freshness_errors(queue: dict) -> list[str]:
    return find_queue_freshness_errors(
        queue,
        cache_dir=CACHE_DIR,
        directory_redraw_mode=DIRECTORY_REDRAW_MODE,
        directory_redraw_source_root=DIRECTORY_REDRAW_SOURCE_ROOT,
        directory_redraw_output_root=DIRECTORY_REDRAW_OUTPUT_ROOT,
        skill_root=SKILL_ROOT,
        image_sheet_order=IMAGE_SHEET_ORDER,
    )


def api_execution_fingerprint() -> str:
    return build_api_execution_fingerprint(
        base_url=BASE_URL,
        project_id=PROJECT_ID,
        model_id=MODEL_ID,
        default_aspect_ratio=DEFAULT_ASPECT_RATIO,
        default_image_size=DEFAULT_IMAGE_SIZE,
    )


def queue_execution_fingerprint(queue: dict) -> str:
    return build_queue_execution_fingerprint(
        queue,
        api_fingerprint=api_execution_fingerprint(),
    )
