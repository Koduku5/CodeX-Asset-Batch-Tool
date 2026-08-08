"""Identity conflict handling and deterministic merging for episode assets."""

from __future__ import annotations

import hashlib

from asset_record_validation import (
    ASSET_ID_PREFIXES,
    ASSET_ID_RE,
    CATEGORY_FILES,
    FACTION_CATEGORIES,
    normalize,
    same_subject_form_family,
    subject_name,
)
from delivery_validation_support import clean_text


class EpisodeAssetMergeError(ValueError):
    pass


def _fail(message: str) -> None:
    raise EpisodeAssetMergeError(message)


def has_explicit_form_name(asset_name: str) -> bool:
    name = clean_text(asset_name)
    return bool(name) and subject_name(name) != name


def category_groups(
    records: dict[str, list[dict[str, object]]],
) -> list[tuple[str, list[dict[str, object]]]]:
    return [
        ("角色/生物/群演", records["characters"] + records["creatures"] + records["extras"]),
        ("场景", records["scenes"]),
        ("道具", records["props"]),
    ]


def identity_group(category: str) -> str:
    return "subjects" if category in FACTION_CATEGORIES else category


def identity_values(record: dict[str, object]) -> list[tuple[str, str]]:
    values = [clean_text(record.get("assetName"))]
    aliases = record.get("aliases", [])
    if isinstance(aliases, list):
        values.extend(clean_text(value) for value in aliases)
    return [(normalize(value), value) for value in values if value]


def pending_id(category: str, record: dict[str, object]) -> str:
    seed = "\n".join(
        (
            category,
            str(record["firstRequiredEpisode"]),
            str(record["firstRequiredOrder"]),
            normalize(clean_text(record.get("assetName"))),
        )
    )
    return f"PENDING-{ASSET_ID_PREFIXES[category]}-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16]}"


def defer_identity_conflicts(
    existing: dict[str, list[dict[str, object]]],
    incoming: dict[str, list[dict[str, object]]],
    pending_records: list[object],
    episode: int,
) -> tuple[dict[str, list[dict[str, object]]], list[object], dict[str, int]]:
    """Move ambiguous incoming assets into the pending staging area without stopping the episode."""
    accepted = {category: [] for category in CATEGORY_FILES}
    deferred: list[tuple[str, dict[str, object], list[dict[str, object]]]] = []
    all_incoming = [
        (category, record)
        for category in CATEGORY_FILES
        for record in incoming[category]
    ]
    all_existing = [
        (category, record)
        for category in CATEGORY_FILES
        for record in existing[category]
    ]

    for category, record in all_incoming:
        name = clean_text(record.get("assetName"))
        own_tokens = {token: value for token, value in identity_values(record)}
        conflicts: list[dict[str, object]] = []
        supplied_id = clean_text(record.get("assetId"))
        updates_existing = any(
            peer_category == category
            and (
                clean_text(peer.get("assetName")) == name
                or (supplied_id and clean_text(peer.get("assetId")) == supplied_id)
            )
            for peer_category, peer in all_existing
        )
        peers = [*all_existing, *all_incoming]
        for peer_category, peer in peers:
            if peer is record or identity_group(peer_category) != identity_group(category):
                continue
            peer_name = clean_text(peer.get("assetName"))
            if peer_category == category and peer_name == name:
                continue
            # A new bare subject name beside existing explicit forms is ambiguous:
            # it may be an accidental duplicate or a genuinely new default form.
            # Keep legal named forms automatic, but send this asymmetric case to
            # the existing human confirmation checkpoint before assigning an ID.
            if (
                not updates_existing
                and not has_explicit_form_name(name)
                and has_explicit_form_name(peer_name)
                and normalize(subject_name(peer_name)) == normalize(name)
            ):
                conflict = {
                    "category": peer_category,
                    "assetId": clean_text(peer.get("assetId")) or None,
                    "assetName": peer_name,
                    "sharedValue": name,
                }
                if conflict not in conflicts:
                    conflicts.append(conflict)
                continue
            for peer_token, peer_value in identity_values(peer):
                if peer_token not in own_tokens:
                    continue
                # Distinct, explicitly named forms of one subject are expected to
                # share the subject's canonical name and dialogue aliases.  That is
                # a one-to-many lookup key, not an unresolved identity collision.
                if same_subject_form_family(record, peer):
                    continue
                conflict = {
                    "category": peer_category,
                    "assetId": clean_text(peer.get("assetId")) or None,
                    "assetName": peer_name,
                    "sharedValue": own_tokens[peer_token] or peer_value,
                }
                if conflict not in conflicts:
                    conflicts.append(conflict)
        if conflicts:
            deferred.append((category, record, conflicts))
        else:
            accepted[category].append(record)

    updated_pending = [dict(item) if isinstance(item, dict) else item for item in pending_records]
    deferred_counts = {category: 0 for category in CATEGORY_FILES}
    for category, record, conflicts in deferred:
        candidate = clean_text(record.get("assetName"))
        conflict_key = tuple(
            sorted(
                (
                    clean_text(item.get("assetId")) or clean_text(item.get("assetName")),
                    normalize(clean_text(item.get("sharedValue"))),
                )
                for item in conflicts
            )
        )
        existing_index = next(
            (
                index
                for index, item in enumerate(updated_pending)
                if isinstance(item, dict)
                and clean_text(item.get("status")) == "pending"
                and clean_text(item.get("proposedCategory")) == category
                and normalize(clean_text(item.get("candidate"))) == normalize(candidate)
                and tuple(
                    sorted(
                        (
                            clean_text(conflict.get("assetId"))
                            or clean_text(conflict.get("assetName")),
                            normalize(clean_text(conflict.get("sharedValue"))),
                        )
                        for conflict in item.get("conflicts", [])
                        if isinstance(conflict, dict)
                    )
                ) == conflict_key
            ),
            None,
        )
        if existing_index is not None:
            previous = dict(updated_pending[existing_index])
            observed = previous.get("observedEpisodes", [])
            observed_episodes = [
                value for value in observed if type(value) is int and value > 0
            ] if isinstance(observed, list) else []
            if episode not in observed_episodes:
                observed_episodes.append(episode)
            previous["observedEpisodes"] = sorted(set(observed_episodes))
            updated_pending[existing_index] = previous
            deferred_counts[category] += 1
            continue

        conflict_text = "、".join(
            f"“{item['assetName']}”共享称呼“{item['sharedValue']}”"
            for item in conflicts
        )
        record_pending_id = pending_id(category, record)
        updated_pending.append(
            {
                "pendingId": record_pending_id,
                "episode": int(record["firstRequiredEpisode"]),
                "observedEpisodes": [episode],
                "candidate": candidate,
                "proposedCategory": category,
                "firstRequiredEpisode": int(record["firstRequiredEpisode"]),
                "firstRequiredOrder": int(record["firstRequiredOrder"]),
                "draftAsset": dict(record),
                "conflicts": conflicts,
                "assetIds": [],
                "assetNames": [],
                "issue": f"候选资产与既有或本集候选发生名称/别名冲突：{conflict_text}。",
                "impact": "影响资产归并、独立建档与别名唯一性；人工确认前暂不写入累计资产。",
                "status": "pending",
            }
        )
        deferred_counts[category] += 1
    return accepted, updated_pending, deferred_counts


def ensure_no_exact_identity_conflicts(records: dict[str, list[dict[str, object]]]) -> None:
    """Reject ambiguous identities while allowing one subject's explicit forms."""
    for label, group in category_groups(records):
        owners: dict[str, dict[str, object]] = {}
        for record in group:
            name = clean_text(record.get("assetName"))
            aliases = record.get("aliases", [])
            values = [name, *(aliases if isinstance(aliases, list) else [])]
            for value in values:
                text = clean_text(value)
                if not text:
                    continue
                token = normalize(text)
                prior = owners.get(token)
                if prior is not None and not same_subject_form_family(record, prior):
                    prior_name = clean_text(prior.get("assetName"))
                    _fail(
                        f"{label}名称/别名冲突：“{name}”与“{prior_name}”共享称呼“{text}”。"
                        "脚本不会自动判断归并，请由 Agent 写入待确认记录。"
                    )
                owners[token] = record

def merge_by_name(
    existing: list[dict[str, object]], incoming: list[dict[str, object]]
) -> list[dict[str, object]]:
    merged = [dict(record) for record in existing]
    positions = {clean_text(record.get("assetName")): index for index, record in enumerate(merged)}
    for record in incoming:
        name = clean_text(record.get("assetName"))
        if name in positions:
            previous = merged[positions[name]]
            replacement = dict(record)
            # Never erase a final visual specification with an episode-level null.
            for field in ("productionNotes", "inferenceBasis"):
                if replacement.get(field) is None and previous.get(field) is not None:
                    replacement[field] = previous[field]
            merged[positions[name]] = replacement
        else:
            positions[name] = len(merged)
            merged.append(record)
    return merged


def protect_first_requirement(
    existing: dict[str, list[dict[str, object]]],
    incoming: dict[str, list[dict[str, object]]],
    episode: int,
) -> None:
    for category in CATEGORY_FILES:
        old_by_name = {
            clean_text(record.get("assetName")): record for record in existing[category]
        }
        for record in incoming[category]:
            name = clean_text(record.get("assetName"))
            old = old_by_name.get(name)
            if old is None:
                if record["firstRequiredEpisode"] != episode:
                    _fail(
                        f"assets.{category} / {name}: 新资产 firstRequiredEpisode 必须等于"
                        f"当前首次同步集数 {episode}，不得把后期资产提前排序"
                    )
                continue
            for field in ("firstRequiredEpisode", "firstRequiredOrder"):
                if record[field] != old.get(field):
                    _fail(
                        f"assets.{category} / {name}: 更新旧资产时不得修改 {field}；"
                        "如需纠正历史排序，请先人工核对累计记录与首次单集分析"
                    )


def assign_asset_ids(
    existing: dict[str, list[dict[str, object]]],
    incoming: dict[str, list[dict[str, object]]],
) -> None:
    """沿用旧 ID，并按每类资产的首次制作顺序为新资产自动编号。"""
    for category in CATEGORY_FILES:
        prefix = ASSET_ID_PREFIXES[category]
        old_by_name = {
            clean_text(record.get("assetName")): record for record in existing[category]
        }
        used_ids: set[str] = set()
        max_sequence = 0
        for record in existing[category]:
            asset_id = clean_text(record.get("assetId"))
            if asset_id in used_ids:
                _fail(f"{CATEGORY_FILES[category]} 存在重复 assetId：{asset_id}")
            used_ids.add(asset_id)
            match = ASSET_ID_RE.fullmatch(asset_id)
            if match:
                max_sequence = max(max_sequence, int(match.group(2)))

        new_records: list[dict[str, object]] = []
        for record in incoming[category]:
            name = clean_text(record.get("assetName"))
            old = old_by_name.get(name)
            supplied_id = clean_text(record.get("assetId"))
            if old is not None:
                old_id = clean_text(old.get("assetId"))
                if not supplied_id:
                    _fail(
                        f"assets.{category} / {name}: 更新旧资产必须填写查询所得的 assetId"
                    )
                if supplied_id != old_id:
                    _fail(f"assets.{category} / {name}: 更新旧资产时不得修改 assetId")
                record["assetId"] = old_id
            else:
                if supplied_id:
                    _fail(f"assets.{category} / {name}: 新资产 assetId 由同步脚本自动分配，请勿手填")
                new_records.append(record)

        new_records.sort(
            key=lambda record: (
                int(record["firstRequiredEpisode"]),
                int(record["firstRequiredOrder"]),
                clean_text(record.get("assetName")),
            )
        )
        next_sequence = max_sequence + 1
        for record in new_records:
            while True:
                asset_id = (
                    f"{prefix}-{next_sequence:03d}-"
                    f"EP{record['firstRequiredEpisode']}"
                )
                next_sequence += 1
                if asset_id not in used_ids:
                    break
            record["assetId"] = asset_id
            used_ids.add(asset_id)


def ensure_asset_ids_unique(records: dict[str, list[dict[str, object]]]) -> None:
    owners: dict[str, str] = {}
    for group in records.values():
        for record in group:
            asset_id = clean_text(record.get("assetId"))
            name = clean_text(record.get("assetName"))
            prior = owners.get(asset_id)
            if prior is not None:
                _fail(f"assetId 重复：{asset_id} 同时分配给“{prior}”与“{name}”")
            owners[asset_id] = name


def ensure_order_unique(records: dict[str, list[dict[str, object]]]) -> None:
    for category, group in records.items():
        owners: dict[tuple[int, int], str] = {}
        for record in group:
            name = clean_text(record.get("assetName"))
            key = (record["firstRequiredEpisode"], record["firstRequiredOrder"])
            prior = owners.get(key)
            if prior is not None:
                _fail(
                    f"{CATEGORY_FILES[category]}：第{key[0]}集 firstRequiredOrder={key[1]} "
                    f"同时分配给“{prior}”与“{name}”"
                )
            owners[key] = name
