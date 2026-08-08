"""Deterministic pending-asset identity allocation and reference remapping."""

from __future__ import annotations

import hashlib

from pending_asset_contracts import fail
from sync_episode_analysis import ASSET_ID_PREFIXES, clean_text


def lineage_id(category: str, record: dict[str, object]) -> str:
    anchor = (
        f"{category}\n{record['firstRequiredEpisode']}\n"
        f"{record['firstRequiredOrder']}"
    )
    digest = hashlib.sha256(anchor.encode("utf-8")).hexdigest()[:20]
    return f"ASSET-{ASSET_ID_PREFIXES[category]}-{digest}"


def next_temporary_id(category: str, records: list[dict[str, object]], episode: int) -> str:
    maximum = 0
    for record in records:
        asset_id = clean_text(record.get("assetId"))
        parts = asset_id.split("-")
        if len(parts) >= 3 and parts[1].isdigit():
            maximum = max(maximum, int(parts[1]))
    return f"{ASSET_ID_PREFIXES[category]}-{maximum + 1:03d}-EP{episode}"


def compact_asset_ids(
    assets: dict[str, list[dict[str, object]]]
) -> tuple[dict[str, list[dict[str, object]]], dict[str, str], list[dict[str, object]]]:
    compacted: dict[str, list[dict[str, object]]] = {}
    mapping: dict[str, str] = {}
    entries: list[dict[str, object]] = []
    for category, records in assets.items():
        ordered = sorted(
            (dict(record) for record in records),
            key=lambda record: (
                int(record["firstRequiredEpisode"]),
                int(record["firstRequiredOrder"]),
                clean_text(record.get("assetName")),
            ),
        )
        for sequence, record in enumerate(ordered, start=1):
            old_id = clean_text(record.get("assetId"))
            new_id = (
                f"{ASSET_ID_PREFIXES[category]}-{sequence:03d}-"
                f"EP{record['firstRequiredEpisode']}"
            )
            if old_id in mapping and mapping[old_id] != new_id:
                fail(f"累计资产包含重复旧编号：{old_id}")
            mapping[old_id] = new_id
            record["assetId"] = new_id
            entries.append(
                {
                    "lineageId": lineage_id(category, record),
                    "category": category,
                    "assetName": clean_text(record.get("assetName")),
                    "firstRequiredEpisode": record["firstRequiredEpisode"],
                    "firstRequiredOrder": record["firstRequiredOrder"],
                    "oldAssetId": old_id,
                    "newAssetId": new_id,
                }
            )
        compacted[category] = ordered
    return compacted, mapping, entries


def remap_pending_references(record: dict[str, object], mapping: dict[str, str]) -> None:
    if isinstance(record.get("assetIds"), list):
        record["assetIds"] = [mapping.get(clean_text(value), clean_text(value)) for value in record["assetIds"]]
    target = clean_text(record.get("targetAssetId"))
    if target:
        record["targetAssetId"] = mapping.get(target, target)
    conflicts = record.get("conflicts")
    if isinstance(conflicts, list):
        for conflict in conflicts:
            if isinstance(conflict, dict):
                old_id = clean_text(conflict.get("assetId"))
                if old_id:
                    conflict["assetId"] = mapping.get(old_id, old_id)
