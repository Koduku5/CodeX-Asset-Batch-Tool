"""Cross-screenplay Cache identity and compatibility validation."""

from __future__ import annotations

import json
from pathlib import Path

from source_manifest_protocol import UserError


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise UserError(f"Cache 文件格式损坏：{path}（第 {exc.lineno} 行）") from None
    except OSError as exc:
        raise UserError(f"无法读取 Cache 文件：{path}（{exc}）") from None


def value_has_data(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return bool(value.strip()) and value not in {"not_started", "idle", "ready"}
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, list):
        return bool(value)
    if isinstance(value, dict):
        return any(value_has_data(item) for item in value.values())
    return True


def cache_has_project_data(cache_dir: Path) -> bool:
    if not cache_dir.exists():
        return False
    if not cache_dir.is_dir():
        raise UserError(f"Cache 路径不是文件夹：{cache_dir}")
    for path in cache_dir.rglob("*"):
        if not path.is_file() or path.name.endswith(".tmp"):
            continue
        if path.name in {
            ".pipeline.lock",
            ".pipeline.operation.lock",
            ".pipeline.api.guard",
            ".pipeline.transaction.json",
            ".validation_receipt.json",
        }:
            continue
        if path.is_relative_to(cache_dir / ".pipeline-transactions"):
            continue
        # UI preferences and elapsed-time metadata may be saved before the first
        # screenplay import. They are not evidence that a screenplay project has
        # already populated this Cache.
        if path == cache_dir / "内置提示词预设.json":
            continue
        if path.parent == cache_dir and (
            path.name == "阶段用时.json"
            or path.name.startswith("阶段用时.json.tmp-")
            or path.name.startswith("阶段用时.json.backup-")
        ):
            continue
        # Folder redraw is an independent API workspace. Its blank schema and
        # completed history do not identify the screenplay currently loaded in
        # this Skill, so they must not trigger the cross-screenplay Cache guard.
        if path.is_relative_to(cache_dir / "批量重绘"):
            continue
        if path.parent.name in {"单集原文", "单集分析"} and path.suffix.casefold() == ".json":
            return True
        if path.suffix.casefold() != ".json":
            if path.stat().st_size:
                return True
            continue
        value = read_json(path)
        if path.name == "阅读进度.json" and isinstance(value, dict):
            if any(
                value_has_data(value.get(field))
                for field in (
                    "sources",
                    "sourceManifest",
                    "discoveredEpisodes",
                    "completedEpisodes",
                    "currentEpisode",
                )
            ):
                return True
            if value.get("status") not in {None, "", "not_started", "idle"}:
                return True
            continue
        if path.name == "世界观记录.json" and isinstance(value, dict):
            if value_has_data(value.get("records")):
                return True
            continue
        if path.name == "世界观分页进度.json" and isinstance(value, dict):
            empty_pagination = {
                "factsFingerprint": "",
                "totalRecords": 0,
                "pageSize": 40,
                "coveredOffsets": [],
                "nextOffset": 0,
                "complete": False,
            }
            if value != empty_pagination:
                return True
            continue
        if path.name in {"出图队列.json", "出图进度.json"} and isinstance(value, dict):
            if value_has_data(value.get("items")):
                return True
            continue
        if value_has_data(value):
            return True
    return False


def validate_existing_cache(cache_dir: Path, manifest: list[dict[str, object]]) -> dict[str, object]:
    progress_path = cache_dir / "阅读进度.json"
    has_data = cache_has_project_data(cache_dir)
    if not progress_path.exists():
        if has_data:
            raise UserError("检测到非空 Cache，但缺少阅读进度.json。请先运行“清空Cache.cmd”后再切分剧本。")
        return {}

    progress = read_json(progress_path)
    if not isinstance(progress, dict):
        raise UserError("阅读进度.json 顶层必须是对象。请先运行“清空Cache.cmd”重置。")
    previous_manifest = progress.get("sourceManifest")
    if previous_manifest is None:
        if has_data:
            raise UserError("检测到旧版非空 Cache，尚无剧本指纹。请先运行“清空Cache.cmd”后再继续。")
        return progress
    if previous_manifest != manifest and has_data:
        raise UserError("当前剧本与 Cache 中记录的剧本不一致。为避免混入旧资产，请先运行“清空Cache.cmd”。")
    return progress



