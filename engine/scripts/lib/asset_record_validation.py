"""Pure structural and semantic validation for cumulative asset records."""

from __future__ import annotations

import re

from delivery_validation_support import clean_text
from world_records_protocol import world_fact_quality_issues

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
FACTION_CATEGORIES = {"characters", "creatures", "extras"}
SUBJECT_CATEGORIES = {"characters", "creatures", "extras"}
REQUIRED_ASSET_FIELDS = {
    "assetId",
    "assetName",
    "productionNotes",
    "scriptSetting",
    "inferenceBasis",
    "aliases",
    "firstRequiredEpisode",
    "firstRequiredOrder",
}
ASSET_FIELD_ORDER = (
    "assetId",
    "assetName",
    "productionNotes",
    "scriptSetting",
    "inferenceBasis",
    "aliases",
    "faction",
    "firstRequiredEpisode",
    "firstRequiredOrder",
)
WORLD_FIELD_ORDER = ("item", "content")
ALLOWED_PENDING_STATUS = {"pending", "resolved"}
SHAPE_SUFFIX_RE = re.compile(r"\s*[（(][^）)]*[）)]\s*$")
VALIDATION_RECEIPT_VERSION = 1
VALIDATOR_PROTOCOL_VERSION = 5


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def subject_name(asset_name: str) -> str:
    return SHAPE_SUFFIX_RE.sub("", clean_text(asset_name)).strip()


def same_subject_form_family(
    left: dict[str, object], right: dict[str, object]
) -> bool:
    left_name = clean_text(left.get("assetName"))
    right_name = clean_text(right.get("assetName"))
    if not left_name or not right_name or normalize(left_name) == normalize(right_name):
        return False
    left_subject = subject_name(left_name)
    right_subject = subject_name(right_name)
    if not left_subject or normalize(left_subject) != normalize(right_subject):
        return False
    return left_subject != left_name or right_subject != right_name


def normalize_field(value: object) -> object:
    if isinstance(value, str):
        return normalize(value)
    if isinstance(value, list):
        return [normalize_field(item) for item in value]
    return value

def complete_asset_record(
    record: object,
    category: str,
    *,
    allow_deferred_visual_fields: bool = False,
) -> bool:
    if not isinstance(record, dict):
        return False
    expected = set(REQUIRED_ASSET_FIELDS)
    if category in FACTION_CATEGORIES:
        expected.add("faction")
    if set(record) != expected:
        return False
    required_text = ("assetId", "assetName", "scriptSetting")
    if not allow_deferred_visual_fields:
        required_text += ("productionNotes", "inferenceBasis")
    if category in FACTION_CATEGORIES:
        required_text += ("faction",)
    return (
        all(clean_text(record.get(field)) for field in required_text)
        and (
            not allow_deferred_visual_fields
            or all(record.get(field) is None for field in ("productionNotes", "inferenceBasis"))
        )
        and isinstance(record.get("aliases"), list)
        and type(record.get("firstRequiredEpisode")) is int
        and record["firstRequiredEpisode"] > 0
        and type(record.get("firstRequiredOrder")) is int
        and record["firstRequiredOrder"] > 0
    )


def complete_world_record(record: object) -> bool:
    return (
        isinstance(record, dict)
        and set(record) == set(WORLD_FIELD_ORDER)
        and all(clean_text(record.get(field)) for field in WORLD_FIELD_ORDER)
    )


def compare_record_fields(
    cumulative: dict[str, object],
    latest: dict[str, object],
    fields: tuple[str, ...],
    location: str,
    errors: list[str],
) -> None:
    for field in fields:
        if field not in cumulative and field not in latest:
            continue
        if normalize_field(cumulative.get(field)) != normalize_field(latest.get(field)):
            errors.append(f"{location}: {field} 与最后一次单集分析修订不一致")


def validate_aliases(value: object, location: str, name: str, errors: list[str]) -> list[str]:
    if not isinstance(value, list):
        errors.append(f"{location}: aliases 必须是数组")
        return []
    aliases: list[str] = []
    seen: set[str] = set()
    for index, alias in enumerate(value, start=1):
        text = clean_text(alias)
        if not text:
            errors.append(f"{location}: aliases[{index}] 必须是非空字符串")
            continue
        key = normalize(text)
        if key == normalize(name):
            errors.append(f"{location}: aliases 不要重复资产名称“{name}”")
        if key in seen:
            errors.append(f"{location}: aliases 存在重复称呼“{text}”")
        seen.add(key)
        aliases.append(text)
    return aliases


def validate_asset_structure(
    record: object,
    category: str,
    location: str,
    discovered: set[int],
    errors: list[str],
    *,
    allow_deferred_visual_fields: bool = False,
) -> tuple[str, str, list[str], int | None, int | None, int | None] | None:
    if not isinstance(record, dict):
        errors.append(f"{location}: 记录必须是对象")
        return None
    missing = sorted(REQUIRED_ASSET_FIELDS.difference(record))
    if category in FACTION_CATEGORIES and "faction" not in record:
        missing.append("faction")
    if missing:
        errors.append(f"{location}: 缺少完整记录字段 {', '.join(missing)}")
    allowed = set(REQUIRED_ASSET_FIELDS)
    if category in FACTION_CATEGORIES:
        allowed.add("faction")
    extra = sorted(set(record).difference(allowed))
    if extra:
        errors.append(f"{location}: 含未定义或已取消字段 {', '.join(extra)}")

    name = clean_text(record.get("assetName"))
    if not name:
        errors.append(f"{location}: assetName 不能为空")
        name = f"row-{location.rsplit('[', 1)[-1].rstrip(']')}"
    aliases = validate_aliases(record.get("aliases"), location, name, errors)
    asset_id = clean_text(record.get("assetId"))
    first_episode = record.get("firstRequiredEpisode")
    first_order = record.get("firstRequiredOrder")
    for field, value in (
        ("firstRequiredEpisode", first_episode),
        ("firstRequiredOrder", first_order),
    ):
        if type(value) is not int or value < 1:
            errors.append(f"{location} / {name}: {field} 必须是正整数")
    if type(first_episode) is int and first_episode not in discovered:
        errors.append(f"{location} / {name}: firstRequiredEpisode 不在已切分集数中")
    asset_sequence: int | None = None
    match = ASSET_ID_RE.fullmatch(asset_id)
    if not match or match.group(1) != ASSET_ID_PREFIXES[category]:
        errors.append(f"{location} / {name}: assetId 格式或类别前缀无效“{asset_id}”")
    else:
        asset_sequence = int(match.group(2))
        if asset_sequence < 1:
            errors.append(f"{location} / {name}: assetId 顺序号必须大于 0")
        if type(first_episode) is int and int(match.group(3)) != first_episode:
            errors.append(
                f"{location} / {name}: assetId 的 EP 必须等于 firstRequiredEpisode"
            )

    if category in FACTION_CATEGORIES:
        faction = clean_text(record.get("faction"))
        if faction.count("｜") != 1 or not all(part.strip() for part in faction.split("｜")):
            errors.append(f"{location} / {name}: 阵营必须且只能包含一个全角“｜”，两侧均不能为空")

    if not clean_text(record.get("scriptSetting")):
        errors.append(f"{location} / {name}: scriptSetting 不能为空")
    for field in ("productionNotes", "inferenceBasis"):
        value = record.get(field)
        if allow_deferred_visual_fields:
            if value is not None:
                errors.append(f"{location} / {name}: 单集阶段 {field} 必须为 null")
        elif not clean_text(value):
            errors.append(f"{location} / {name}: {field} 不能为空")

    return (
        asset_id,
        name,
        aliases,
        first_episode if type(first_episode) is int else None,
        first_order if type(first_order) is int else None,
        asset_sequence,
    )


def validate_analysis(
    value: object,
    raw: dict[str, object] | None,
    episode: int,
    discovered: set[int],
    errors: list[str],
) -> tuple[
    dict[str, dict[str, object]],
    dict[
        str,
        dict[
            str,
            tuple[str, int | None, int | None, dict[str, object] | None],
        ],
    ],
]:
    world_records: dict[str, dict[str, object]] = {}
    asset_records: dict[
        str,
        dict[
            str,
            tuple[str, int | None, int | None, dict[str, object] | None],
        ],
    ] = {
        category: {} for category in CATEGORY_FILES
    }
    asset_keys = {category: set() for category in CATEGORY_FILES}
    label = f"第{episode:03d}集分析"
    if not isinstance(value, dict):
        errors.append(f"{label}: 顶层必须是对象")
        return world_records, asset_records
    required = {"source", "episode", "scriptAnalysis", "assets", "exclusions"}
    missing = sorted(required.difference(value))
    if missing:
        errors.append(f"{label}: 缺少字段 {', '.join(missing)}")
    if value.get("episode") != episode:
        errors.append(f"{label}: episode 必须等于 {episode}")
    if raw is not None and value.get("source") != raw.get("source"):
        errors.append(f"{label}: source 必须与对应单集原文完全一致")

    script_analysis = value.get("scriptAnalysis")
    if not isinstance(script_analysis, list):
        errors.append(f"{label}: scriptAnalysis 必须是数组")
    else:
        for index, record in enumerate(script_analysis, start=1):
            location = f"{label}.scriptAnalysis[{index}]"
            if not isinstance(record, dict):
                errors.append(f"{location}: 必须是对象")
                continue
            extra = sorted(set(record).difference(WORLD_FIELD_ORDER))
            if extra:
                errors.append(f"{location}: 含未定义字段 {', '.join(extra)}")
            for field in WORLD_FIELD_ORDER:
                if not clean_text(record.get(field)):
                    errors.append(f"{location}.{field} 不能为空")
            item = clean_text(record.get("item"))
            content = clean_text(record.get("content"))
            if item and content:
                for issue in world_fact_quality_issues(item, content):
                    errors.append(f"{location}: 世界观质量不合格：{issue}")
            item = clean_text(record.get("item"))
            if item:
                key = normalize(item)
                if key in world_records:
                    errors.append(f"{label}: scriptAnalysis 存在重复 item“{item}”")
                if complete_world_record(record):
                    world_records[key] = dict(record)

    assets = value.get("assets")
    if not isinstance(assets, dict):
        errors.append(f"{label}: assets 必须是对象")
    else:
        if set(assets) != set(CATEGORY_FILES):
            errors.append(f"{label}: assets 必须且只能包含 characters、creatures、extras、scenes、props")
        for category in CATEGORY_FILES:
            records = assets.get(category)
            if not isinstance(records, list):
                errors.append(f"{label}.assets.{category} 必须是数组")
                continue
            for index, record in enumerate(records, start=1):
                result = validate_asset_structure(
                    record,
                    category,
                    f"{label}.assets.{category}[{index}]",
                    discovered,
                    errors,
                    allow_deferred_visual_fields=True,
                )
                if result:
                    asset_id, name = result[0], result[1]
                    name_key = normalize(name)
                    if name_key in asset_keys[category]:
                        errors.append(f"{label}.assets.{category}: assetName 重复“{name}”")
                    asset_keys[category].add(name_key)
                    if asset_id:
                        if asset_id in asset_records[category]:
                            errors.append(
                                f"{label}.assets.{category}: assetId 重复“{asset_id}”"
                            )
                        full_record = (
                            dict(record)
                            if complete_asset_record(
                                record,
                                category,
                                allow_deferred_visual_fields=True,
                            )
                            else None
                        )
                        asset_records[category][asset_id] = (
                            name,
                            result[3],
                            result[4],
                            full_record,
                        )

    exclusions = value.get("exclusions")
    if not isinstance(exclusions, list):
        errors.append(f"{label}: exclusions 必须是数组")
    else:
        for index, record in enumerate(exclusions, start=1):
            location = f"{label}.exclusions[{index}]"
            if not isinstance(record, dict):
                errors.append(f"{location}: 必须是对象")
                continue
            for field in ("item", "reason"):
                if not clean_text(record.get(field)):
                    errors.append(f"{location}.{field} 不能为空")
    return world_records, asset_records

def validate_pending_record(
    record: object,
    index: int,
    discovered: set[int],
    asset_id_owners: dict[str, str],
    all_asset_names: set[str],
    asset_ids_by_name: dict[str, set[str]],
    errors: list[str],
) -> None:
    """Validate one pending/resolved decision without requiring a pre-existing asset."""
    location = f"待确认记录[{index}]"
    if not isinstance(record, dict):
        errors.append(f"{location}: 必须是对象")
        return
    episode = record.get("episode")
    if type(episode) is not int or episode not in discovered:
        errors.append(f"{location}.episode 必须属于已切分集数")
    for field in ("candidate", "issue", "impact", "status"):
        if not clean_text(record.get(field)):
            errors.append(f"{location}.{field} 必须是非空字符串")
    status = clean_text(record.get("status"))
    if status and status not in ALLOWED_PENDING_STATUS:
        errors.append(f"{location}.status 只能是 pending 或 resolved")
    if "resolution" in record and not isinstance(record.get("resolution"), str):
        errors.append(f"{location}.resolution 必须是字符串")
    if status == "resolved" and not clean_text(record.get("resolution")):
        errors.append(f"{location}.resolution 在 resolved 状态下必须填写明确结论")

    draft = record.get("draftAsset")
    if draft is not None:
        pending_id = clean_text(record.get("pendingId"))
        category = clean_text(record.get("proposedCategory"))
        if not pending_id or not re.fullmatch(r"PENDING-[A-Z]+-[a-f0-9]{16}", pending_id):
            errors.append(f"{location}.pendingId 必须是正式候选暂存 ID")
        if category not in CATEGORY_FILES:
            errors.append(f"{location}.proposedCategory 必须是五类资产之一")
        if not isinstance(draft, dict):
            errors.append(f"{location}.draftAsset 必须是对象")
        else:
            candidate = clean_text(record.get("candidate"))
            if clean_text(draft.get("assetName")) != candidate:
                errors.append(f"{location}.draftAsset.assetName 必须等于 candidate")
            for field in ("firstRequiredEpisode", "firstRequiredOrder"):
                value = record.get(field)
                if type(value) is not int or value < 1:
                    errors.append(f"{location}.{field} 必须是正整数")
                if draft.get(field) != value:
                    errors.append(f"{location}.draftAsset.{field} 必须与占位字段一致")
            if record.get("firstRequiredEpisode") != record.get("episode"):
                errors.append(f"{location}.episode 必须等于 firstRequiredEpisode")
            aliases = draft.get("aliases")
            if not isinstance(aliases, list) or any(not clean_text(alias) for alias in aliases):
                errors.append(f"{location}.draftAsset.aliases 必须是非空字符串数组")
            for field in ("scriptSetting",):
                if not clean_text(draft.get(field)):
                    errors.append(f"{location}.draftAsset.{field} 必须是非空字符串")
            for field in ("productionNotes", "inferenceBasis"):
                value = draft.get(field)
                if value is not None and not clean_text(value):
                    errors.append(f"{location}.draftAsset.{field} 必须是字符串或 null")
            if category in FACTION_CATEGORIES and not clean_text(draft.get("faction")):
                errors.append(f"{location}.draftAsset.faction 不能为空")
            if category in CATEGORY_FILES and category not in FACTION_CATEGORIES and "faction" in draft:
                errors.append(f"{location}.draftAsset 不得包含 faction")
        observed = record.get("observedEpisodes")
        if (
            not isinstance(observed, list)
            or not observed
            or any(type(value) is not int or value not in discovered for value in observed)
        ):
            errors.append(f"{location}.observedEpisodes 必须是已切分集数的非空数组")
        conflicts = record.get("conflicts")
        if not isinstance(conflicts, list) or not conflicts:
            errors.append(f"{location}.conflicts 必须是非空数组")
        else:
            for conflict_index, conflict in enumerate(conflicts, start=1):
                conflict_location = f"{location}.conflicts[{conflict_index}]"
                if not isinstance(conflict, dict):
                    errors.append(f"{conflict_location} 必须是对象")
                    continue
                if clean_text(conflict.get("category")) not in CATEGORY_FILES:
                    errors.append(f"{conflict_location}.category 无效")
                if not clean_text(conflict.get("assetName")):
                    errors.append(f"{conflict_location}.assetName 不能为空")
                if not clean_text(conflict.get("sharedValue")):
                    errors.append(f"{conflict_location}.sharedValue 不能为空")
                conflict_id = conflict.get("assetId")
                if conflict_id is not None and not clean_text(conflict_id):
                    errors.append(f"{conflict_location}.assetId 必须是字符串或 null")

    # A not-yet-created candidate deliberately has two empty reference arrays.
    # Non-empty references still have to resolve exactly to cumulative assets.
    asset_ids = record.get("assetIds", [])
    if not isinstance(asset_ids, list):
        errors.append(f"{location}.assetIds 必须是数组")
        asset_ids = []
    cleaned_ids = [clean_text(asset_id) for asset_id in asset_ids]
    if any(not asset_id for asset_id in cleaned_ids):
        errors.append(f"{location}.assetIds 只能包含非空字符串")
    if len(set(cleaned_ids)) != len(cleaned_ids):
        errors.append(f"{location}.assetIds 不得重复")
    unknown_ids = sorted(
        {asset_id for asset_id in cleaned_ids if asset_id and asset_id not in asset_id_owners}
    )
    if unknown_ids:
        errors.append(f"{location}.assetIds 未指向累计资产：{', '.join(unknown_ids)}")

    asset_names = record.get("assetNames")
    if not isinstance(asset_names, list):
        errors.append(f"{location}.assetNames 必须是数组")
        asset_names = []
    cleaned_names = [clean_text(name) for name in asset_names]
    if any(not name for name in cleaned_names):
        errors.append(f"{location}.assetNames 只能包含非空字符串")
    if len(set(cleaned_names)) != len(cleaned_names):
        errors.append(f"{location}.assetNames 不得重复")
    unknown = sorted({name for name in cleaned_names if name and name not in all_asset_names})
    if unknown:
        errors.append(f"{location}.assetNames 未指向累计资产：{', '.join(unknown)}")
    ambiguous = sorted(
        name
        for name in cleaned_names
        if len(asset_ids_by_name.get(name, set())) > 1
    )
    if status == "pending" and not cleaned_ids and ambiguous:
        errors.append(
            f"{location}.assetNames 跨类别重名，必须改用 assetIds：{', '.join(ambiguous)}"
        )
    if cleaned_ids and cleaned_names:
        names_from_ids = {
            asset_id_owners[asset_id]
            for asset_id in cleaned_ids
            if asset_id in asset_id_owners
        }
        supplied_names = set(cleaned_names)
        if names_from_ids != supplied_names:
            errors.append(f"{location}.assetIds 与 assetNames 必须精确指向同一批资产")
