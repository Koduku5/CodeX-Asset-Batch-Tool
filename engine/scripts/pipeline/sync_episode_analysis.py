import hashlib
import json
import re
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from pipeline_protocol import (  # noqa: E402
    ProtocolError,
    acquire_pipeline_lock,
    recover_pending_transaction,
    release_pipeline_lock,
    require_pipeline_lock,
    transactional_commit_json,
)
from source_manifest_protocol import (  # noqa: E402
    UserError as SourceUserError,
    build_source_manifest,
    validate_root_and_sources,
)
from world_records_protocol import world_fact_quality_issues  # noqa: E402


CATEGORY_FILES = {
    "characters": "角色记录.json",
    "creatures": "生物记录.json",
    "extras": "群演记录.json",
    "scenes": "场景记录.json",
    "props": "道具记录.json",
}
ASSET_ID_PREFIXES = {
    "characters": "CHAR",
    "creatures": "CREATURE",
    "extras": "CROWD",
    "scenes": "SCENE",
    "props": "PROP",
}
ASSET_ID_RE = re.compile(r"^(CHAR|CREATURE|CROWD|SCENE|PROP)-(\d{3,})-EP([1-9]\d*)$")
SHAPE_SUFFIX_RE = re.compile(r"\s*[（(][^）)]*[）)]\s*$")
FACTION_CATEGORIES = {"characters", "creatures", "extras"}
REQUIRED_ASSET_FIELDS = {
    "assetName",
    "productionNotes",
    "scriptSetting",
    "inferenceBasis",
    "aliases",
    "firstRequiredEpisode",
    "firstRequiredOrder",
}


class UserError(Exception):
    pass


def fail(message: str) -> None:
    raise UserError(message)


def read_json(path: Path, expected: str) -> object:
    if not path.is_file():
        fail(f"缺少{expected}：{path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        fail(f"{expected}不是有效 JSON：{path.name}（第 {exc.lineno} 行）")
    except OSError as exc:
        fail(f"无法读取{expected}：{path}（{exc}）")


def clean_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def subject_name(asset_name: str) -> str:
    return SHAPE_SUFFIX_RE.sub("", clean_text(asset_name)).strip()


def same_subject_form_family(
    left: dict[str, object], right: dict[str, object]
) -> bool:
    """Return whether two distinct asset names are explicit forms of one subject."""
    left_name = clean_text(left.get("assetName"))
    right_name = clean_text(right.get("assetName"))
    if not left_name or not right_name or normalize(left_name) == normalize(right_name):
        return False
    left_subject = subject_name(left_name)
    right_subject = subject_name(right_name)
    if not left_subject or normalize(left_subject) != normalize(right_subject):
        return False
    return left_subject != left_name or right_subject != right_name


def has_explicit_form_name(asset_name: str) -> bool:
    name = clean_text(asset_name)
    return bool(name) and subject_name(name) != name


def validate_aliases(value: object, location: str, asset_name: str) -> list[str]:
    if not isinstance(value, list):
        fail(f"{location}.aliases 必须是数组")
    aliases: list[str] = []
    seen: set[str] = set()
    for index, alias in enumerate(value, start=1):
        text = clean_text(alias)
        if not text:
            fail(f"{location}.aliases[{index}] 必须是非空字符串")
        key = normalize(text)
        if key == normalize(asset_name):
            fail(f"{location}.aliases 不要重复资产名称“{asset_name}”")
        if key in seen:
            fail(f"{location}.aliases 存在重复称呼“{text}”")
        seen.add(key)
        aliases.append(text)
    return aliases


def validate_asset_record(
    record: object,
    category: str,
    index: int,
    discovered: set[int],
    *,
    require_asset_id: bool,
) -> dict[str, object]:
    location = f"assets.{category}[{index}]"
    if not isinstance(record, dict):
        fail(f"{location} 必须是完整记录对象")
    missing = sorted(REQUIRED_ASSET_FIELDS.difference(record))
    if category in FACTION_CATEGORIES and "faction" not in record:
        missing.append("faction")
    if require_asset_id and "assetId" not in record:
        missing.append("assetId")
    if missing:
        fail(f"{location} 缺少完整记录字段：{', '.join(missing)}")
    allowed = set(REQUIRED_ASSET_FIELDS)
    allowed.add("assetId")
    if category in FACTION_CATEGORIES:
        allowed.add("faction")
    extra = sorted(set(record).difference(allowed))
    if extra:
        fail(f"{location} 含未定义或已取消字段：{', '.join(extra)}")

    asset_name = clean_text(record.get("assetName"))
    if not asset_name:
        fail(f"{location}.assetName 不能为空")
    for field in ("scriptSetting",):
        if not clean_text(record.get(field)):
            fail(f"{location}.{field} 必须是非空字符串")
    for field in ("productionNotes", "inferenceBasis"):
        value = record.get(field)
        if value is not None and not clean_text(value):
            fail(f"{location}.{field} 必须是字符串或 null")
    aliases = validate_aliases(record.get("aliases"), location, asset_name)
    for field in ("firstRequiredEpisode", "firstRequiredOrder"):
        value = record.get(field)
        if type(value) is not int or value < 1:
            fail(f"{location}.{field} 必须是正整数")
    if record["firstRequiredEpisode"] not in discovered:
        fail(f"{location}.firstRequiredEpisode 不在已切分集数中")
    asset_id = clean_text(record.get("assetId"))
    if asset_id:
        match = ASSET_ID_RE.fullmatch(asset_id)
        if not match or match.group(1) != ASSET_ID_PREFIXES[category]:
            fail(f"{location}.assetId 格式或类别前缀无效：{asset_id}")
        if int(match.group(2)) < 1:
            fail(f"{location}.assetId 顺序号必须大于 0")
        if int(match.group(3)) != record["firstRequiredEpisode"]:
            fail(f"{location}.assetId 的 EP 必须等于 firstRequiredEpisode")
    elif require_asset_id:
        fail(f"{location}.assetId 不能为空")
    if category in FACTION_CATEGORIES:
        faction = clean_text(record.get("faction"))
        if faction.count("｜") != 1 or not all(part.strip() for part in faction.split("｜")):
            fail(f"{location}.faction 必须且只能包含一个“｜”，两侧均不能为空")

    result = dict(record)
    result["assetName"] = asset_name
    result["aliases"] = aliases
    if asset_id:
        result["assetId"] = asset_id
    return result


def validate_world_record(record: object, index: int) -> dict[str, object]:
    location = f"scriptAnalysis[{index}]"
    if not isinstance(record, dict):
        fail(f"{location} 必须是对象")
    extra = sorted(set(record).difference({"item", "content"}))
    if extra:
        fail(f"{location} 含未定义字段：{', '.join(extra)}")
    result = dict(record)
    for field in ("item", "content"):
        text = clean_text(record.get(field))
        if not text:
            fail(f"{location}.{field} 必须是非空字符串")
        result[field] = text
    quality_issues = world_fact_quality_issues(result["item"], result["content"])
    if quality_issues:
        fail(f"{location} 世界观质量不合格：{'；'.join(quality_issues)}")
    return result


def validate_exclusion(record: object, index: int) -> None:
    location = f"exclusions[{index}]"
    if not isinstance(record, dict):
        fail(f"{location} 必须是对象")
    for field in ("item", "reason"):
        if not clean_text(record.get(field)):
            fail(f"{location}.{field} 必须是非空字符串")


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
                    fail(
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
                    fail(
                        f"assets.{category} / {name}: 新资产 firstRequiredEpisode 必须等于"
                        f"当前首次同步集数 {episode}，不得把后期资产提前排序"
                    )
                continue
            for field in ("firstRequiredEpisode", "firstRequiredOrder"):
                if record[field] != old.get(field):
                    fail(
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
                fail(f"{CATEGORY_FILES[category]} 存在重复 assetId：{asset_id}")
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
                    fail(
                        f"assets.{category} / {name}: 更新旧资产必须填写查询所得的 assetId"
                    )
                if supplied_id != old_id:
                    fail(f"assets.{category} / {name}: 更新旧资产时不得修改 assetId")
                record["assetId"] = old_id
            else:
                if supplied_id:
                    fail(f"assets.{category} / {name}: 新资产 assetId 由同步脚本自动分配，请勿手填")
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
                fail(f"assetId 重复：{asset_id} 同时分配给“{prior}”与“{name}”")
            owners[asset_id] = name


def ensure_order_unique(records: dict[str, list[dict[str, object]]]) -> None:
    for category, group in records.items():
        owners: dict[tuple[int, int], str] = {}
        for record in group:
            name = clean_text(record.get("assetName"))
            key = (record["firstRequiredEpisode"], record["firstRequiredOrder"])
            prior = owners.get(key)
            if prior is not None:
                fail(
                    f"{CATEGORY_FILES[category]}：第{key[0]}集 firstRequiredOrder={key[1]} "
                    f"同时分配给“{prior}”与“{name}”"
                )
            owners[key] = name


def main() -> None:
    if len(sys.argv) != 3:
        fail("用法：sync_episode_analysis.py <skill-root> <episode>")
    root, source_files = validate_root_and_sources(sys.argv[1])
    try:
        episode = int(sys.argv[2])
    except ValueError:
        fail(f"无效集数：{sys.argv[2]}")
    if episode < 1:
        fail(f"无效集数：{episode}")

    cache = root / "cache"
    operation_lock = acquire_pipeline_lock(
        cache,
        "analysis_sync",
        f"episode:{episode}",
        lease_mode="transient",
        lock_name=".pipeline.operation.lock",
    )
    try:
        run_sync(root, source_files, episode, cache)
    finally:
        release_pipeline_lock(
            cache,
            operation_lock,
            lock_name=".pipeline.operation.lock",
        )


def run_sync(root: Path, source_files: list[Path], episode: int, cache: Path) -> None:
    recover_pending_transaction(cache)
    progress = read_json(cache / "阅读进度.json", "阅读进度")
    if not isinstance(progress, dict):
        fail("阅读进度.json 顶层必须是对象")
    session_token = clean_text(progress.get("currentSessionToken"))
    if not session_token:
        fail("阅读进度缺少 currentSessionToken，禁止同步当前分析会话")
    require_pipeline_lock(
        cache,
        kind="analysis_episode",
        key=f"episode:{episode}",
        token=session_token,
    )
    if progress.get("sourceManifest") != build_source_manifest(source_files):
        fail("剧本指纹与阅读进度不一致，请先重新切分或清空 Cache")
    discovered_value = progress.get("discoveredEpisodes")
    if not isinstance(discovered_value, list):
        fail("阅读进度.discoveredEpisodes 必须是数组")
    discovered = {item for item in discovered_value if type(item) is int and item > 0}
    if len(discovered) != len(discovered_value):
        fail("阅读进度.discoveredEpisodes 只能包含不重复的正整数")
    if episode not in discovered:
        fail(f"第{episode}集不在已切分集数中")
    if progress.get("status") != "in_progress" or progress.get("currentEpisode") != episode:
        fail(f"第{episode}集尚未执行 start，不能同步单集分析")

    raw_path = cache / "单集原文" / f"第{episode:03d}集.json"
    analysis_path = cache / "单集分析" / f"第{episode:03d}集.json"
    raw = read_json(raw_path, "单集原文")
    analysis = read_json(analysis_path, "单集分析")
    if not isinstance(raw, dict) or not isinstance(analysis, dict):
        fail("单集原文与单集分析顶层必须是对象")
    episode_manifest = progress.get("episodeManifest")
    expected_raw = (
        next(
            (
                item
                for item in episode_manifest
                if isinstance(item, dict) and item.get("episode") == episode
            ),
            None,
        )
        if isinstance(episode_manifest, list)
        else None
    )
    raw_fingerprint = hashlib.sha256(
        json.dumps(
            raw,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    if not isinstance(expected_raw, dict) or expected_raw.get("sha256") != raw_fingerprint:
        fail("单集原文与切分指纹不一致；旧 Cache 请重新运行 extract_screenplay.py")
    if analysis.get("episode") != episode or raw.get("episode") != episode:
        fail(f"第{episode}集文件中的 episode 字段不一致")
    source = clean_text(raw.get("source"))
    if not source or analysis.get("source") != source:
        fail(f"第{episode}集分析的 source 必须与单集原文完全一致")
    source_names = {clean_text(item.get("name")) for item in progress["sourceManifest"]}
    if source not in source_names:
        fail(f"第{episode}集原文的 source 不在当前剧本指纹中")

    expected_keys = {"source", "episode", "scriptAnalysis", "assets", "exclusions"}
    missing_keys = sorted(expected_keys.difference(analysis))
    if missing_keys:
        fail(f"第{episode}集分析缺少字段：{', '.join(missing_keys)}")
    script_analysis = analysis.get("scriptAnalysis")
    if not isinstance(script_analysis, list):
        fail("scriptAnalysis 必须是数组")
    world_updates = [
        validate_world_record(record, index)
        for index, record in enumerate(script_analysis, start=1)
    ]
    if len({normalize(clean_text(item["item"])) for item in world_updates}) != len(world_updates):
        fail("scriptAnalysis 中存在重复 item")

    exclusions = analysis.get("exclusions")
    if not isinstance(exclusions, list):
        fail("exclusions 必须是数组")
    for index, record in enumerate(exclusions, start=1):
        validate_exclusion(record, index)

    assets = analysis.get("assets")
    if not isinstance(assets, dict):
        fail("assets 必须是对象")
    if set(assets) != set(CATEGORY_FILES):
        missing = sorted(set(CATEGORY_FILES).difference(assets))
        extra = sorted(set(assets).difference(CATEGORY_FILES))
        details = []
        if missing:
            details.append(f"缺少 {', '.join(missing)}")
        if extra:
            details.append(f"未知 {', '.join(extra)}")
        fail("assets 必须且只能包含 characters、creatures、extras、scenes、props（" + "；".join(details) + "）")

    incoming: dict[str, list[dict[str, object]]] = {}
    for category in CATEGORY_FILES:
        value = assets[category]
        if not isinstance(value, list):
            fail(f"assets.{category} 必须是数组")
        incoming[category] = [
            validate_asset_record(
                record,
                category,
                index,
                discovered,
                require_asset_id=False,
            )
            for index, record in enumerate(value, start=1)
        ]
        names = [clean_text(record["assetName"]) for record in incoming[category]]
        if len(set(names)) != len(names):
            fail(f"assets.{category} 中存在重复 assetName")

    registry = cache / "累计记录"
    existing: dict[str, list[dict[str, object]]] = {}
    target_values: dict[Path, object] = {}
    for category, filename in CATEGORY_FILES.items():
        path = registry / filename
        value = read_json(path, filename)
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            fail(f"{filename} 顶层必须是对象数组")
        existing[category] = [
            validate_asset_record(
                record,
                category,
                index,
                discovered,
                require_asset_id=True,
            )
            for index, record in enumerate(value, start=1)
        ]
    ensure_no_exact_identity_conflicts(existing)
    protect_first_requirement(existing, incoming, episode)
    pending_path = cache / "待确认记录.json"
    pending_records = read_json(pending_path, "待确认记录.json")
    if not isinstance(pending_records, list):
        fail("待确认记录.json 顶层必须是数组")
    incoming, updated_pending, deferred_counts = defer_identity_conflicts(
        existing,
        incoming,
        pending_records,
        episode,
    )
    if updated_pending != pending_records:
        target_values[pending_path] = updated_pending
    assign_asset_ids(existing, incoming)

    merged = {
        category: merge_by_name(existing[category], incoming[category])
        for category in CATEGORY_FILES
    }
    ensure_no_exact_identity_conflicts(merged)
    ensure_asset_ids_unique(merged)
    ensure_order_unique(merged)
    for category, filename in CATEGORY_FILES.items():
        target_values[registry / filename] = merged[category]

    world_path = registry / "世界观记录.json"
    world = read_json(world_path, "世界观记录.json")
    if (
        not isinstance(world, dict)
        or set(world) != {"records"}
        or not isinstance(world.get("records"), list)
    ):
        fail("世界观记录.json 必须是包含 records 数组的对象")
    existing_world = world["records"]
    if not all(isinstance(record, dict) for record in existing_world):
        fail("世界观记录.records 必须是对象数组")
    positions: dict[str, int] = {}
    merged_world = [
        validate_world_record(record, index)
        for index, record in enumerate(existing_world, start=1)
    ]
    for index, record in enumerate(merged_world):
        item = clean_text(record.get("item"))
        if not item:
            fail(f"世界观记录.records[{index + 1}].item 不能为空")
        key = normalize(item)
        if key in positions:
            fail(f"世界观记录存在重复 item：“{item}”")
        positions[key] = index
    for record in world_updates:
        key = normalize(clean_text(record["item"]))
        if key in positions:
            merged_world[positions[key]] = record
        else:
            positions[key] = len(merged_world)
            merged_world.append(record)
    target_values[world_path] = {"records": merged_world}

    analysis["scriptAnalysis"] = world_updates
    analysis["assets"] = incoming
    target_values[analysis_path] = analysis

    _, current_source_files = validate_root_and_sources(str(root))
    if progress.get("sourceManifest") != build_source_manifest(current_source_files):
        fail("剧本文件在本集同步期间发生变化，已停止写入；请重新切分或清空 Cache")
    transactional_commit_json(cache, "episode_analysis_sync", target_values)
    print(
        json.dumps(
            {
                "ok": True,
                "episode": episode,
                "worldUpdates": len(world_updates),
                "assetUpdates": {key: len(value) for key, value in incoming.items()},
                "deferredAssets": deferred_counts,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (UserError, SourceUserError, ProtocolError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"错误：同步单集分析失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
