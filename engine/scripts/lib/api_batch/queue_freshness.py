"""Queue path resolution, source freshness, and execution fingerprints."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from api_batch.file_runtime import cached_file_sha256, is_within
from api_batch.image_validation import valid_reference_image
from api_batch.progress_store import clean_text
from api_batch.queue_validation import queue_operation, safe_relative_parts, valid_api_prompt_batch


def resolve_skill_file(relative_path: str, label: str, skill_root: Path) -> Path:
    if not clean_text(relative_path):
        raise ValueError(f"{label} path is empty")
    target = (skill_root / relative_path).resolve()
    try:
        common = Path(os.path.commonpath([str(target), str(skill_root)]))
    except ValueError as error:
        raise ValueError(f"{label} path escapes Skill root: {relative_path}") from error
    if os.path.normcase(str(common)) != os.path.normcase(str(skill_root)):
        raise ValueError(f"{label} path escapes Skill root: {relative_path}")
    return target


def resolve_reference_file(
    relative_path: str,
    *,
    directory_redraw_mode: bool,
    directory_redraw_source_root: Path | None,
    skill_root: Path,
) -> Path:
    if not directory_redraw_mode:
        return resolve_skill_file(relative_path, "reference", skill_root)
    if directory_redraw_source_root is None:
        raise ValueError("directory redraw source root is not configured")
    parts = safe_relative_parts(relative_path, "批量重绘原图路径")
    target = directory_redraw_source_root.joinpath(*parts).resolve()
    if not is_within(target, directory_redraw_source_root):
        raise ValueError(f"reference path escapes configured source root: {relative_path}")
    return target


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reference_freshness_errors(
    queue: dict,
    *,
    directory_redraw_mode: bool,
    directory_redraw_source_root: Path | None,
    skill_root: Path,
) -> list[str]:
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
            reference = resolve_reference_file(
                references[0],
                directory_redraw_mode=directory_redraw_mode,
                directory_redraw_source_root=directory_redraw_source_root,
                skill_root=skill_root,
            )
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


def queue_freshness_errors(
    queue: dict,
    *,
    cache_dir: Path,
    directory_redraw_mode: bool,
    directory_redraw_source_root: Path | None,
    directory_redraw_output_root: Path | None,
    skill_root: Path,
    image_sheet_order: tuple[str, ...],
) -> list[str]:
    reference_errors = reference_freshness_errors(
        queue,
        directory_redraw_mode=directory_redraw_mode,
        directory_redraw_source_root=directory_redraw_source_root,
        skill_root=skill_root,
    )
    if queue_operation(queue) == "directory_redraw":
        if directory_redraw_output_root is None or not directory_redraw_output_root.is_dir():
            reference_errors.append("批量重绘结果目录不存在")
        return list(dict.fromkeys(reference_errors))

    errors = []
    pending_path = cache_dir / "待确认记录.json"
    try:
        if file_sha256(pending_path) != queue.get("eligibilityFingerprint"):
            errors.append("待确认记录已变化")
    except OSError:
        errors.append("待确认记录不存在或无法读取")

    if valid_api_prompt_batch(queue, image_sheet_order):
        resources = queue.get("routingResourceFingerprints")
        if not isinstance(resources, dict) or not resources:
            errors.append("队列缺少路由资源指纹")
        else:
            for relative_path, expected in resources.items():
                try:
                    resource = resolve_skill_file(relative_path, "routing resource", skill_root)
                    if file_sha256(resource) != expected:
                        errors.append(f"出图路由资源已变化：{relative_path}")
                except (OSError, ValueError):
                    errors.append(f"出图路由资源缺失：{relative_path}")

    errors.extend(reference_errors)
    return list(dict.fromkeys(errors))


def api_execution_fingerprint(
    *,
    base_url: str,
    project_id: str,
    model_id: str,
    default_aspect_ratio: str,
    default_image_size: str,
) -> str:
    payload = {
        "baseUrl": base_url,
        "projectId": project_id,
        "modelId": model_id,
        "aspectRatio": default_aspect_ratio,
        "imageSize": default_image_size,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def queue_execution_fingerprint(queue: dict, *, api_fingerprint: str) -> str:
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
        "apiExecutionFingerprint": api_fingerprint,
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
