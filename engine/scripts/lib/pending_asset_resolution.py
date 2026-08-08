"""Human-reviewed pending asset decisions and deterministic finalization."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pipeline_protocol import recover_pending_transaction, transactional_commit_json
from sync_episode_analysis import (
    ASSET_ID_PREFIXES,
    CATEGORY_FILES,
    clean_text,
    ensure_asset_ids_unique,
    ensure_no_exact_identity_conflicts,
    ensure_order_unique,
    normalize,
    validate_asset_record,
)

DECISIONS = {"independent", "merge", "exclude"}
DOWNSTREAM_PATHS = (
    Path("cache/视觉规格回填进度.json"),
    Path("cache/.validation_receipt.json"),
    Path("cache/资产表范围.json"),
    Path("cache/出图队列.json"),
    Path("cache/出图进度.json"),
    Path("输出/剧本资产制表.xlsx"),
)
EMPTY_DOWNSTREAM_PLACEHOLDERS = {
    Path("cache/出图队列.json"): {"version": 4, "items": []},
    Path("cache/出图进度.json"): {"version": 3, "items": {}},
}
LEDGER_PATH = Path("cache/资产编号沿革.json")


class UserError(Exception):
    pass


def fail(message: str) -> None:
    raise UserError(message)


def now_text() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def canonical_sha256(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def read_json(path: Path, label: str) -> object:
    if not path.is_file():
        fail(f"缺少{label}：{path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{label}不是有效 JSON：{exc}")


def parse_payload() -> dict[str, object]:
    try:
        value = json.load(sys.stdin)
    except (OSError, json.JSONDecodeError):
        fail("人工确认提交不是有效 JSON")
    if not isinstance(value, dict):
        fail("人工确认提交顶层必须是对象")
    allowed = {"pendingId", "decision", "resolution", "targetAssetId", "finalAsset"}
    extra = sorted(set(value).difference(allowed))
    if extra:
        fail("人工确认提交含未定义字段：" + "、".join(extra))
    for field in ("pendingId", "decision", "resolution"):
        if not clean_text(value.get(field)):
            fail(f"人工确认提交.{field} 必须是非空字符串")
    decision = clean_text(value.get("decision"))
    if decision not in DECISIONS:
        fail("人工确认提交.decision 只能是 independent、merge 或 exclude")
    if decision == "merge" and not clean_text(value.get("targetAssetId")):
        fail("合并决定必须提供 targetAssetId")
    if decision in {"independent", "merge"} and not isinstance(value.get("finalAsset"), dict):
        fail("独立建档或合并决定必须提供人工核定的 finalAsset 完整记录")
    if decision == "exclude" and ("targetAssetId" in value or "finalAsset" in value):
        fail("排除决定不得提供 targetAssetId 或 finalAsset")
    return value


def load_progress(cache: Path) -> tuple[set[int], list[int]]:
    progress = read_json(cache / "阅读进度.json", "阅读进度")
    if not isinstance(progress, dict):
        fail("阅读进度.json 顶层必须是对象")
    discovered = progress.get("discoveredEpisodes")
    completed = progress.get("completedEpisodes")
    if (
        progress.get("status") != "complete"
        or not isinstance(discovered, list)
        or not discovered
        or not isinstance(completed, list)
        or discovered != completed
        or any(type(item) is not int or item < 1 for item in discovered)
    ):
        fail("必须先完成全部单集分析，才能提交待确认结论")
    if not (cache / "世界观总览.json").is_file():
        fail("必须先完成世界观总览，才能提交待确认结论")
    return set(discovered), discovered


def assert_no_downstream_artifacts(root: Path) -> None:
    existing = []
    for relative in DOWNSTREAM_PATHS:
        path = root / relative
        if not path.exists():
            continue
        placeholder = EMPTY_DOWNSTREAM_PLACEHOLDERS.get(relative)
        if placeholder is not None:
            try:
                if json.loads(path.read_text(encoding="utf-8-sig")) == placeholder:
                    continue
            except (OSError, json.JSONDecodeError):
                pass
        existing.append(path.as_posix())
    if existing:
        fail("已经建立依赖资产 ID 的下游产物，禁止自动整理编号：" + "、".join(existing))


def load_assets(cache: Path) -> dict[str, list[dict[str, object]]]:
    registry = cache / "累计记录"
    result: dict[str, list[dict[str, object]]] = {}
    for category, filename in CATEGORY_FILES.items():
        value = read_json(registry / filename, filename)
        if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
            fail(f"{filename} 顶层必须是完整记录数组")
        result[category] = [dict(item) for item in value]
    return result


def find_asset(
    assets: dict[str, list[dict[str, object]]], asset_id: str
) -> tuple[str, dict[str, object]]:
    matches = [
        (category, record)
        for category, records in assets.items()
        for record in records
        if clean_text(record.get("assetId")) == asset_id
    ]
    if len(matches) != 1:
        fail(f"targetAssetId 无法唯一命中累计资产：{asset_id}")
    return matches[0]


def validate_final_asset(
    value: object,
    category: str,
    discovered: set[int],
) -> dict[str, object]:
    if not isinstance(value, dict):
        fail("finalAsset 必须是完整记录对象")
    if "assetId" in value:
        fail("finalAsset 不得填写 assetId；正式编号由固定脚本统一生成")
    record = validate_asset_record(
        value,
        category,
        1,
        discovered,
        require_asset_id=False,
    )
    if record.get("productionNotes") is not None or record.get("inferenceBasis") is not None:
        fail("人工确认阶段不得提前填写视觉规格字段")
    return record


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
    """Keep every existing episode reference aligned after a human edits an anchor."""
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


def apply_staged_decisions(
    cache: Path,
    assets: dict[str, list[dict[str, object]]],
    pending: list[object],
    discovered: set[int],
    episodes: list[int],
) -> tuple[dict[Path, object], dict[str, object]]:
    analyses = load_analyses(cache, episodes)
    staged = [
        item
        for item in pending
        if isinstance(item, dict)
        and isinstance(item.get("draftAsset"), dict)
        and clean_text(item.get("status")) == "resolved"
        and not clean_text(item.get("appliedAt"))
    ]
    seen_merge_targets: set[str] = set()
    applied: list[dict[str, object]] = []
    before = json.loads(
        json.dumps(
            {
                "assets": assets,
                "analyses": {path.name: value for path, value in analyses.items()},
                "pending": pending,
            },
            ensure_ascii=False,
        )
    )
    preexisting_ids = {
        clean_text(record.get("assetId"))
        for records in assets.values()
        for record in records
    }

    for item in staged:
        decision = clean_text(item.get("decision"))
        category = clean_text(item.get("proposedCategory"))
        candidate = clean_text(item.get("candidate"))
        observed = sorted(
            set(
                value
                for value in item.get("observedEpisodes", [])
                if type(value) is int and value in discovered
            )
        )
        if item.get("firstRequiredEpisode") not in observed:
            observed.insert(0, int(item["firstRequiredEpisode"]))
        source_id = ""
        if decision == "independent":
            final = validate_final_asset(
                item.get("finalAsset"),
                category,
                discovered,
            )
            source_id = next_temporary_id(category, assets[category], int(final["firstRequiredEpisode"]))
            final["assetId"] = source_id
            assets[category].append(final)
        elif decision == "merge":
            target_id = clean_text(item.get("targetAssetId"))
            if target_id in seen_merge_targets:
                fail(f"多个待确认项同时合并到 {target_id}；请提交一份合并后的统一最终记录")
            seen_merge_targets.add(target_id)
            target_category, target = find_asset(assets, target_id)
            final = validate_final_asset(
                item.get("finalAsset"),
                target_category,
                discovered,
            )
            source_id = target_id
            final["assetId"] = target_id
            target.clear()
            target.update(final)
            category = target_category
        elif decision == "exclude":
            for episode in observed:
                add_episode_exclusion(
                    analyses[cache / "单集分析" / f"第{episode:03d}集.json"],
                    candidate,
                    clean_text(item.get("resolution")),
                )
            applied.append({"pending": item, "decision": decision, "sourceAssetId": None})
            continue
        else:
            fail(f"待确认项缺少有效人工决定：{item.get('pendingId')}")
        corrected_episode = int(final["firstRequiredEpisode"])
        if corrected_episode not in observed:
            observed.append(corrected_episode)
            observed.sort()
        applied.append(
            {
                "pending": item,
                "decision": decision,
                "sourceAssetId": source_id,
                "category": category,
                "observed": observed,
            }
        )

    ensure_order_unique(assets)
    ensure_no_exact_identity_conflicts(assets)
    compacted, mapping, lineage_entries = compact_asset_ids(assets)
    ensure_asset_ids_unique(compacted)

    for analysis in analyses.values():
        groups = analysis.get("assets")
        if not isinstance(groups, dict):
            fail("单集分析 assets 结构无效")
        for records in groups.values():
            if not isinstance(records, list):
                fail("单集分析资产类别必须是数组")
            for record in records:
                if isinstance(record, dict):
                    old_id = clean_text(record.get("assetId"))
                    if old_id in mapping:
                        record["assetId"] = mapping[old_id]

    final_by_id = {
        clean_text(record.get("assetId")): (category, record)
        for category, records in compacted.items()
        for record in records
    }
    for item in pending:
        if isinstance(item, dict):
            remap_pending_references(item, mapping)
    timestamp = now_text()
    for entry in applied:
        item = entry["pending"]
        if entry["decision"] != "exclude":
            new_id = mapping[entry["sourceAssetId"]]
            final_category, final_record = final_by_id[new_id]
            replace_episode_asset_references(
                analyses,
                final_category,
                new_id,
                final_record,
            )
            for episode in entry["observed"]:
                upsert_episode_asset(
                    analyses[cache / "单集分析" / f"第{episode:03d}集.json"],
                    final_category,
                    final_record,
                )
            item["assetIds"] = [new_id]
            item["assetNames"] = [clean_text(final_record.get("assetName"))]
            item["finalAssetId"] = new_id
        else:
            item["assetIds"] = []
            item["assetNames"] = []
        item["appliedAt"] = timestamp
    ledger = load_ledger(cache)
    revisions = ledger["revisions"]
    changed = [
        entry
        for entry in lineage_entries
        if entry["oldAssetId"] in preexisting_ids
        and entry["oldAssetId"] != entry["newAssetId"]
    ]
    created = [entry for entry in lineage_entries if entry["oldAssetId"] not in preexisting_ids]
    after = {
        "assets": compacted,
        "analyses": {path.name: value for path, value in analyses.items()},
        "pending": pending,
    }
    revisions.append(
        {
            "revision": len(revisions) + 1,
            "finalizedAt": timestamp,
            "pendingIds": [clean_text(entry["pending"].get("pendingId")) for entry in applied],
            "beforeFingerprint": canonical_sha256(before),
            "afterFingerprint": canonical_sha256(after),
            "mappings": changed,
            "created": created,
        }
    )

    values: dict[Path, object] = {
        cache / "待确认记录.json": pending,
        cache / LEDGER_PATH.name: ledger,
        **analyses,
    }
    registry = cache / "累计记录"
    for category, filename in CATEGORY_FILES.items():
        values[registry / filename] = compacted[category]
    return values, {
        "finalized": True,
        "appliedCount": len(applied),
        "renumberedCount": len(changed),
        "ledgerRevision": len(revisions),
    }


def submit_decision(root: Path, payload: dict[str, object]) -> dict[str, object]:
    cache = root / "cache"
    recover_pending_transaction(cache)
    discovered, episodes = load_progress(cache)
    assert_no_downstream_artifacts(root)
    pending_path = cache / "待确认记录.json"
    value = read_json(pending_path, "待确认记录")
    if not isinstance(value, list):
        fail("待确认记录.json 顶层必须是数组")
    pending = [dict(item) if isinstance(item, dict) else item for item in value]
    pending_id = clean_text(payload.get("pendingId"))
    matches = [
        item
        for item in pending
        if isinstance(item, dict) and clean_text(item.get("pendingId")) == pending_id
    ]
    if len(matches) != 1:
        fail(f"pendingId 无法唯一命中待确认项：{pending_id}")
    item = matches[0]
    if clean_text(item.get("status")) != "pending":
        fail(f"待确认项已经处理：{pending_id}")
    if not isinstance(item.get("draftAsset"), dict):
        fail("该待确认项属于旧协议，请先迁移为包含 draftAsset 的暂存记录")

    decision = clean_text(payload.get("decision"))
    item["decision"] = decision
    item["resolution"] = clean_text(payload.get("resolution"))
    item["status"] = "resolved"
    item["resolvedAt"] = now_text()
    if decision == "merge":
        item["targetAssetId"] = clean_text(payload.get("targetAssetId"))
    if decision in {"independent", "merge"}:
        item["finalAsset"] = dict(payload["finalAsset"])

    unresolved = sum(
        1
        for entry in pending
        if isinstance(entry, dict) and clean_text(entry.get("status")) == "pending"
    )
    if unresolved:
        transactional_commit_json(cache, "pending_asset_decision", {pending_path: pending})
        return {"finalized": False, "pendingId": pending_id, "remaining": unresolved}

    assets = load_assets(cache)
    values, result = apply_staged_decisions(
        cache,
        assets,
        pending,
        discovered,
        episodes,
    )
    transactional_commit_json(cache, "pending_asset_finalize", values)
    return {"pendingId": pending_id, "remaining": 0, **result}
