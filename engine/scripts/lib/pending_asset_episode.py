"""Episode-analysis updates and lineage-ledger loading for pending decisions."""

from __future__ import annotations

from pathlib import Path

from pending_asset_contracts import LEDGER_PATH, fail, read_json
from sync_episode_analysis import clean_text, normalize


def upsert_episode_asset(
    analysis: dict[str, object], category: str, record: dict[str, object]
) -> None:
    assets = analysis.get("assets")
    if not isinstance(assets, dict) or not isinstance(assets.get(category), list):
        fail(f"单集分析 assets.{category} 结构无效")
    records = assets[category]
    matches = [
        index
        for index, item in enumerate(records)
        if isinstance(item, dict)
        and (
            clean_text(item.get("assetId")) == clean_text(record.get("assetId"))
            or normalize(clean_text(item.get("assetName")))
            == normalize(clean_text(record.get("assetName")))
        )
    ]
    if len(matches) > 1:
        fail(f"单集分析中无法唯一更新资产：{record.get('assetName')}")
    if matches:
        records[matches[0]] = dict(record)
    else:
        records.append(dict(record))


def replace_episode_asset_references(
    analyses: dict[Path, dict[str, object]],
    category: str,
    asset_id: str,
    record: dict[str, object],
) -> None:
    for analysis in analyses.values():
        groups = analysis.get("assets")
        if not isinstance(groups, dict) or not isinstance(groups.get(category), list):
            fail(f"单集分析 assets.{category} 结构无效")
        records = groups[category]
        matches = [
            index
            for index, item in enumerate(records)
            if isinstance(item, dict) and clean_text(item.get("assetId")) == asset_id
        ]
        if len(matches) > 1:
            fail(f"单集分析中同一资产编号重复：{asset_id}")
        if matches:
            records[matches[0]] = dict(record)


def add_episode_exclusion(analysis: dict[str, object], candidate: str, reason: str) -> None:
    exclusions = analysis.get("exclusions")
    if not isinstance(exclusions, list):
        fail("单集分析 exclusions 结构无效")
    match = next(
        (
            item
            for item in exclusions
            if isinstance(item, dict)
            and normalize(clean_text(item.get("item"))) == normalize(candidate)
        ),
        None,
    )
    if match is None:
        exclusions.append({"item": candidate, "reason": reason})
    else:
        match["reason"] = reason


def load_analyses(cache: Path, episodes: list[int]) -> dict[Path, dict[str, object]]:
    result: dict[Path, dict[str, object]] = {}
    for episode in episodes:
        path = cache / "单集分析" / f"第{episode:03d}集.json"
        value = read_json(path, f"第{episode:03d}集分析")
        if not isinstance(value, dict):
            fail(f"第{episode:03d}集分析顶层必须是对象")
        result[path] = value
    return result


def load_ledger(cache: Path) -> dict[str, object]:
    path = cache / LEDGER_PATH.name
    if not path.exists():
        return {"version": 1, "revisions": []}
    value = read_json(path, "资产编号沿革")
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or not isinstance(value.get("revisions"), list)
    ):
        fail("资产编号沿革.json 结构无效")
    return value
