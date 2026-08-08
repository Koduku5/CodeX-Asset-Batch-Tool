"""Reading-progress, episode-source, and episode-analysis delivery validation."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from asset_record_validation import CATEGORY_FILES, normalize, validate_analysis
from delivery_validation_support import clean_text, load_json, valid_iso_timestamp
from world_records_protocol import FINGERPRINT_RE


@dataclass(frozen=True)
class AnalysisValidationState:
    analysis_complete: bool
    discovered: set[int]
    analysis_world_latest: dict[str, dict[str, object]]
    analysis_asset_ids: dict[str, set[str]]
    analysis_asset_latest: dict[str, dict[str, dict[str, object]]]
    analysis_first: dict[str, dict[str, tuple[int, int | None, int | None]]]


def validate_analysis_delivery(
    root: Path,
    source_manifest: list[dict[str, object]],
    errors: list[str],
) -> AnalysisValidationState:
    cache = root / "cache"
    progress = load_json(cache / "阅读进度.json", "阅读进度", errors)
    analysis_complete = isinstance(progress, dict) and progress.get("status") == "complete"
    discovered: set[int] = set()
    completed: set[int] = set()
    manifest_names: set[str] = set()
    episode_manifest: dict[int, str] = {}
    if isinstance(progress, dict):
        if progress.get("status") != "complete":
            errors.append("阅读进度.status 必须是 complete，全部单集完成后才能导出")
        if progress.get("sourceManifest") != source_manifest:
            errors.append("阅读进度.sourceManifest 与当前剧本文件的名称、大小或 SHA-256 不一致")
        manifest_names = {
            clean_text(item.get("name"))
            for item in source_manifest
            if isinstance(item, dict) and clean_text(item.get("name"))
        }
        expected_sources = [
            clean_text(item.get("name"))
            for item in source_manifest
            if isinstance(item, dict) and clean_text(item.get("name"))
        ]
        if progress.get("sources") != expected_sources:
            errors.append("阅读进度.sources 必须与当前 sourceManifest 的文件顺序完全一致")
        episode_manifest_value = progress.get("episodeManifest")
        if not isinstance(episode_manifest_value, list):
            errors.append("阅读进度.episodeManifest 缺失；旧 Cache 请重新运行 extract_screenplay.py")
        else:
            for item in episode_manifest_value:
                if (
                    not isinstance(item, dict)
                    or set(item) != {"episode", "sha256"}
                    or type(item.get("episode")) is not int
                    or item["episode"] < 1
                    or not isinstance(item.get("sha256"), str)
                    or not FINGERPRINT_RE.fullmatch(item["sha256"])
                    or item["episode"] in episode_manifest
                ):
                    errors.append("阅读进度.episodeManifest 含无效或重复条目")
                    episode_manifest = {}
                    break
                episode_manifest[item["episode"]] = item["sha256"]
        discovered_value = progress.get("discoveredEpisodes")
        if not isinstance(discovered_value, list) or not discovered_value:
            errors.append("阅读进度.discoveredEpisodes 必须是非空数组")
        else:
            valid = [item for item in discovered_value if type(item) is int and item > 0]
            if len(valid) != len(discovered_value) or len(set(valid)) != len(valid):
                errors.append("阅读进度.discoveredEpisodes 只能包含不重复的正整数")
            elif valid != sorted(valid):
                errors.append("阅读进度.discoveredEpisodes 必须按集数升序排列")
            discovered = set(valid)
        completed_value = progress.get("completedEpisodes")
        if not isinstance(completed_value, list):
            errors.append("阅读进度.completedEpisodes 必须是数组")
        else:
            completed = {item for item in completed_value if type(item) is int and item > 0}
            if len(completed) != len(completed_value):
                errors.append("阅读进度.completedEpisodes 只能包含不重复的正整数")
            elif completed_value != sorted(completed_value):
                errors.append("阅读进度.completedEpisodes 必须按集数升序排列")
            if completed != discovered:
                errors.append("阅读进度.completedEpisodes 必须与 discoveredEpisodes 完全一致")
        if episode_manifest and set(episode_manifest) != discovered:
            errors.append("阅读进度.episodeManifest 集数必须与 discoveredEpisodes 完全一致")
        if discovered and progress.get("lastCompletedEpisode") != max(discovered):
            errors.append("阅读进度.lastCompletedEpisode 必须等于最后一集")
        for field in (
            "currentEpisode",
            "currentStartedAt",
            "currentSessionToken",
            "currentResumedAt",
        ):
            if progress.get(field) is not None:
                errors.append(f"阅读进度 complete 状态下 {field} 必须为 null")
        if not valid_iso_timestamp(progress.get("pipelineStartedAt")):
            errors.append("阅读进度.pipelineStartedAt 必须是带时区的 ISO 时间")
        if not valid_iso_timestamp(progress.get("updatedAt")):
            errors.append("阅读进度.updatedAt 必须是带时区的 ISO 时间")
    elif progress is not None:
        errors.append("阅读进度.json 顶层必须是对象")

    expected_episode_files = {f"第{episode:03d}集.json" for episode in discovered}
    for directory_name in ("单集原文", "单集分析"):
        directory = cache / directory_name
        if not directory.is_dir():
            errors.append(f"缺少{directory_name}文件夹：{directory}")
            continue
        actual = {path.name for path in directory.glob("第*集.json") if path.is_file()}
        stale = sorted(actual.difference(expected_episode_files))
        if stale:
            errors.append(f"{directory_name}存在不属于当前剧本的文件：{', '.join(stale)}")

    analysis_world_latest: dict[str, dict[str, object]] = {}
    analysis_asset_ids = {category: set() for category in CATEGORY_FILES}
    analysis_asset_latest: dict[str, dict[str, dict[str, object]]] = {
        category: {} for category in CATEGORY_FILES
    }
    analysis_first: dict[str, dict[str, tuple[int, int | None, int | None]]] = {
        category: {} for category in CATEGORY_FILES
    }
    analysis_name_ids: dict[str, dict[str, str]] = {
        category: {} for category in CATEGORY_FILES
    }
    for episode in sorted(discovered):
        raw = load_json(cache / "单集原文" / f"第{episode:03d}集.json", f"第{episode:03d}集原文", errors)
        raw_dict = raw if isinstance(raw, dict) else None
        if raw is not None and raw_dict is None:
            errors.append(f"第{episode:03d}集原文顶层必须是对象")
        if raw_dict is not None:
            if raw_dict.get("episode") != episode:
                errors.append(f"第{episode:03d}集原文.episode 必须等于 {episode}")
            source = clean_text(raw_dict.get("source"))
            if source not in manifest_names:
                errors.append(f"第{episode:03d}集原文.source 不在当前 sourceManifest 中")
            paragraphs = raw_dict.get("paragraphs")
            if not isinstance(paragraphs, list) or not paragraphs:
                errors.append(f"第{episode:03d}集原文.paragraphs 必须是非空数组")
            elif not all(isinstance(item, str) and item.strip() for item in paragraphs):
                errors.append(f"第{episode:03d}集原文.paragraphs 只能包含非空字符串")
            if isinstance(paragraphs, list) and raw_dict.get("effectiveParagraphs") != len(paragraphs):
                errors.append(f"第{episode:03d}集原文.effectiveParagraphs 与 paragraphs 数量不一致")
            raw_fingerprint = hashlib.sha256(
                json.dumps(
                    raw_dict,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            if episode_manifest.get(episode) != raw_fingerprint:
                errors.append(f"第{episode:03d}集原文与阅读进度.episodeManifest 指纹不一致")
        analysis = load_json(
            cache / "单集分析" / f"第{episode:03d}集.json",
            f"第{episode:03d}集分析",
            errors,
        )
        episode_world_records, episode_assets = validate_analysis(
            analysis, raw_dict, episode, discovered, errors
        )
        analysis_world_latest.update(episode_world_records)
        for category in CATEGORY_FILES:
            for asset_id, (
                name,
                declared_episode,
                declared_order,
                full_record,
            ) in episode_assets[category].items():
                analysis_asset_ids[category].add(asset_id)
                name_key = normalize(name)
                prior_name = analysis_name_ids[category].get(name_key)
                if prior_name is not None and prior_name != asset_id:
                    errors.append(
                        f"{CATEGORY_FILES[category]} / {name}: 同一资产名称在单集分析中"
                        f"对应多个 assetId（{prior_name}、{asset_id}）"
                    )
                analysis_name_ids[category][name_key] = asset_id
                first = analysis_first[category].get(asset_id)
                if first is None:
                    analysis_first[category][asset_id] = (
                        episode,
                        declared_episode,
                        declared_order,
                    )
                    if declared_episode != episode:
                        errors.append(
                            f"{CATEGORY_FILES[category]} / {name}: 首次出现在第{episode}集分析，"
                            f"firstRequiredEpisode 却为 {declared_episode}"
                        )
                elif declared_episode != first[0] or declared_order != first[2]:
                    errors.append(
                        f"{CATEGORY_FILES[category]} / {name}: 后续单集修订不得改变"
                        "首次需求集数或顺序"
                    )
                if full_record is not None:
                    analysis_asset_latest[category][asset_id] = full_record

    return AnalysisValidationState(
        analysis_complete=analysis_complete,
        discovered=discovered,
        analysis_world_latest=analysis_world_latest,
        analysis_asset_ids=analysis_asset_ids,
        analysis_asset_latest=analysis_asset_latest,
        analysis_first=analysis_first,
    )
