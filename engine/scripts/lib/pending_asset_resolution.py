"""Transactional orchestration for human-reviewed pending asset decisions."""

from __future__ import annotations

import json
from pathlib import Path

from pending_asset_contracts import (
    CATEGORY_FILES,
    EMPTY_DOWNSTREAM_PLACEHOLDERS,
    LEDGER_PATH,
    UserError,
    assert_no_downstream_artifacts,
    canonical_sha256,
    fail,
    find_asset,
    load_assets,
    load_progress,
    now_text,
    parse_payload,
    read_json,
    validate_final_asset,
)
from pending_asset_episode import (
    add_episode_exclusion,
    load_analyses,
    load_ledger,
    replace_episode_asset_references,
    upsert_episode_asset,
)
from pending_asset_identity import (
    compact_asset_ids,
    next_temporary_id,
    remap_pending_references,
)
from pipeline_protocol import recover_pending_transaction, transactional_commit_json
from sync_episode_analysis import (
    clean_text,
    ensure_asset_ids_unique,
    ensure_no_exact_identity_conflicts,
    ensure_order_unique,
)


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
