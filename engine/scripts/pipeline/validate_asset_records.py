import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from pipeline_protocol import (  # noqa: E402
    acquire_pipeline_lock,
    atomic_write_json,
    recover_pending_transaction,
    release_pipeline_lock,
)
from delivery_validation_support import clean_text, load_json, valid_iso_timestamp  # noqa: E402
from source_manifest_protocol import (  # noqa: E402
    build_source_manifest,
    validate_root_and_sources,
)
from world_records_protocol import (  # noqa: E402
    FINGERPRINT_RE,
    canonical_sha256,
    world_fact_quality_issues,
)
from world_delivery_validation import (  # noqa: E402
    validate_visual_spec_progress,
    validate_world_overview,
)


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
VALIDATION_RECEIPT_VERSION = 1
VALIDATOR_PROTOCOL_VERSION = 5


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def normalize_field(value: object) -> object:
    if isinstance(value, str):
        return normalize(value)
    if isinstance(value, list):
        return [normalize_field(item) for item in value]
    return value


def validation_input_paths(root: Path) -> list[Path]:
    cache = root / "cache"
    fixed = [
        cache / "阅读进度.json",
        cache / "待确认记录.json",
        cache / "世界观分页进度.json",
        cache / "世界观总览.json",
        cache / "视觉规格回填进度.json",
        cache / "累计记录" / "世界观记录.json",
        cache / "累计记录" / "角色记录.json",
        cache / "累计记录" / "生物记录.json",
        cache / "累计记录" / "群演记录.json",
        cache / "累计记录" / "场景记录.json",
        cache / "累计记录" / "道具记录.json",
    ]
    discovered = []
    try:
        progress = json.loads((cache / "阅读进度.json").read_text(encoding="utf-8-sig"))
        if isinstance(progress, dict) and isinstance(progress.get("discoveredEpisodes"), list):
            discovered = [
                value
                for value in progress["discoveredEpisodes"]
                if type(value) is int and value > 0
            ]
    except (OSError, json.JSONDecodeError):
        pass
    episode_paths = [
        cache / directory / f"第{episode:03d}集.json"
        for episode in discovered
        for directory in ("单集原文", "单集分析")
    ]
    sources = []
    screenplay = root / "剧本"
    if screenplay.is_dir():
        sources = sorted(
            (
                path
                for path in screenplay.iterdir()
                if path.is_file()
                and not path.name.startswith("~$")
                and path.suffix.casefold() in {".docx", ".txt"}
            ),
            key=lambda path: path.name.casefold(),
        )
    return sorted(
        {path.resolve(strict=False) for path in (*sources, *fixed, *episode_paths)},
        key=lambda path: path.as_posix().casefold(),
    )


def validation_snapshot(root: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    resolved_root = root.resolve()
    for path in validation_input_paths(root):
        try:
            relative = path.relative_to(resolved_root).as_posix()
        except ValueError:
            raise RuntimeError(f"校验输入越出 Skill 根目录：{path}") from None
        if not path.is_file():
            files.append({"path": relative, "sha256": "missing"})
            continue
        files.append({"path": relative, "sha256": stable_file_sha256(path)})
    return files


def stable_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            after_handle = os.fstat(handle.fileno())
        after_path = path.stat()
    except OSError as exc:
        raise RuntimeError(f"无法稳定读取校验输入：{path}（{exc}）") from None
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if any(
        getattr(before, field, None) != getattr(after_handle, field, None)
        or getattr(before, field, None) != getattr(after_path, field, None)
        for field in stable_fields
    ):
        raise RuntimeError(f"校验输入在计算指纹期间发生变化：{path}")
    return digest.hexdigest()


def write_validation_receipt(root: Path, snapshot: list[dict[str, str]]) -> None:
    atomic_write_json(
        root / "cache" / ".validation_receipt.json",
        {
            "version": VALIDATION_RECEIPT_VERSION,
            "validatorProtocolVersion": VALIDATOR_PROTOCOL_VERSION,
            "snapshotFingerprint": canonical_sha256({"files": snapshot}),
            "files": snapshot,
            "validatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
    )


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


def validate_locked() -> int:
    errors: list[str] = []
    root_arg = sys.argv[1] if len(sys.argv) == 2 else None
    if root_arg is None:
        errors.append("用法：validate_asset_records.py <skill-root>")
        root = Path(".").resolve()
        source_manifest: list[dict[str, object]] = []
    else:
        root = Path(root_arg).expanduser().resolve()
        try:
            root, source_files = validate_root_and_sources(root_arg)
            source_manifest = build_source_manifest(source_files)
        except Exception as exc:
            errors.append(str(exc))
            source_manifest = []

    cache = root / "cache"
    receipt_path = cache / ".validation_receipt.json"
    if root_arg is not None:
        receipt_path.unlink(missing_ok=True)
    start_snapshot = validation_snapshot(root) if root_arg is not None else []
    registry = cache / "累计记录"
    progress_path = cache / "阅读进度.json"
    progress = load_json(progress_path, "阅读进度", errors)
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
        if progress.get("currentEpisode") is not None:
            errors.append("阅读进度 complete 状态下 currentEpisode 必须为 null")
        if progress.get("currentStartedAt") is not None:
            errors.append("阅读进度 complete 状态下 currentStartedAt 必须为 null")
        if progress.get("currentSessionToken") is not None:
            errors.append("阅读进度 complete 状态下 currentSessionToken 必须为 null")
        if progress.get("currentResumedAt") is not None:
            errors.append("阅读进度 complete 状态下 currentResumedAt 必须为 null")
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
    analysis_asset_latest: dict[
        str, dict[str, dict[str, object]]
    ] = {category: {} for category in CATEGORY_FILES}
    analysis_first: dict[
        str, dict[str, tuple[int, int | None, int | None]]
    ] = {
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
                elif (
                    declared_episode != first[0]
                    or declared_order != first[2]
                ):
                    errors.append(
                        f"{CATEGORY_FILES[category]} / {name}: 后续单集修订不得改变"
                        "首次需求集数或顺序"
                    )
                if full_record is not None:
                    analysis_asset_latest[category][asset_id] = full_record

    cumulative_ids: dict[str, set[str]] = {
        category: set() for category in CATEGORY_FILES
    }
    cumulative_name_keys: dict[str, set[str]] = {
        category: set() for category in CATEGORY_FILES
    }
    total = 0
    people_names: dict[str, str] = {}
    identity_owners: dict[str, dict[str, str]] = {
        "people": {},
        "scenes": {},
        "props": {},
    }
    asset_id_owners: dict[str, str] = {}
    all_asset_names: set[str] = set()
    asset_ids_by_name: dict[str, set[str]] = {}
    asset_facts: list[dict[str, object]] = []
    for category, filename in CATEGORY_FILES.items():
        value = load_json(registry / filename, filename, errors)
        if not isinstance(value, list):
            if value is not None:
                errors.append(f"{filename}: 顶层必须是数组")
            continue
        order_keys: dict[tuple[int, int], str] = {}
        sequence_order: list[tuple[int, int, int, str]] = []
        for index, record in enumerate(value, start=1):
            total += 1
            location = f"{filename}[{index}]"
            result = validate_asset_structure(
                record,
                category,
                location,
                discovered,
                errors,
            )
            if not result:
                continue
            asset_id, name, aliases, first_episode, first_order, asset_sequence = result
            fact: dict[str, object] = {
                "category": category,
                "assetId": asset_id,
                "assetName": record["assetName"],
                "scriptSetting": record["scriptSetting"],
                "aliases": record["aliases"],
                "firstRequiredEpisode": record["firstRequiredEpisode"],
                "firstRequiredOrder": record["firstRequiredOrder"],
            }
            if category in FACTION_CATEGORIES:
                fact["faction"] = record["faction"]
            asset_facts.append(fact)
            prior_id_owner = asset_id_owners.get(asset_id)
            if prior_id_owner is not None:
                errors.append(
                    f"assetId 重复：{asset_id} 同时分配给“{prior_id_owner}”与“{name}”"
                )
            asset_id_owners[asset_id] = name
            name_key = normalize(name)
            if name_key in cumulative_name_keys[category]:
                errors.append(f"{filename}: assetName 重复“{name}”")
            cumulative_name_keys[category].add(name_key)
            cumulative_ids[category].add(asset_id)
            all_asset_names.add(name)
            asset_ids_by_name.setdefault(name, set()).add(asset_id)
            first_analysis = analysis_first[category].get(asset_id)
            if first_analysis is None:
                errors.append(f"{filename} / {name}: 累计资产未在任何单集分析中出现")
            else:
                if first_episode != first_analysis[0]:
                    errors.append(
                        f"{filename} / {name}: firstRequiredEpisode={first_episode}，"
                        f"但首次出现在第{first_analysis[0]}集分析"
                    )
                if first_order != first_analysis[2]:
                    errors.append(
                        f"{filename} / {name}: firstRequiredOrder 与首次单集分析不一致"
                    )
            latest_analysis = analysis_asset_latest[category].get(asset_id)
            if latest_analysis is not None:
                fields = tuple(
                    field
                    for field in ASSET_FIELD_ORDER
                    if field not in {"productionNotes", "inferenceBasis"}
                    and (field != "faction" or category in FACTION_CATEGORIES)
                )
                compare_record_fields(
                    record,
                    latest_analysis,
                    fields,
                    f"{filename} / {asset_id} / {name}",
                    errors,
                )
            if first_episode is not None and first_order is not None:
                key = (first_episode, first_order)
                prior = order_keys.get(key)
                if prior:
                    errors.append(
                        f"{filename}: 第{first_episode}集 firstRequiredOrder={first_order} "
                        f"同时分配给“{prior}”与“{name}”"
                    )
                order_keys[key] = name
                if asset_sequence is not None:
                    sequence_order.append(
                        (first_episode, first_order, asset_sequence, name)
                    )
            if category in SUBJECT_CATEGORIES:
                prior_category = people_names.get(name)
                if prior_category and prior_category != category:
                    errors.append(f"{name}: 不得跨角色、生物、群演重复登记")
                people_names[name] = category
            identity_group = "people" if category in SUBJECT_CATEGORIES else category
            identity_label = {
                "people": "角色/生物/群演",
                "scenes": "场景",
                "props": "道具",
            }[identity_group]
            for identity in [name, *aliases]:
                key = normalize(identity)
                prior = identity_owners[identity_group].get(key)
                if prior and prior != name:
                    errors.append(
                        f"{identity_label}名称或别名冲突：“{name}”与“{prior}”共享“{identity}”"
                    )
                identity_owners[identity_group][key] = name
        ordered_sequences = [
            item[2] for item in sorted(sequence_order, key=lambda item: (item[0], item[1]))
        ]
        if any(
            current <= previous
            for previous, current in zip(ordered_sequences, ordered_sequences[1:])
        ):
            errors.append(f"{filename}: assetId 顺序号必须随首次制作顺序递增")
    if total == 0:
        errors.append("全项目交付至少需要一项角色、生物、群演、场景或道具资产")

    for category, asset_ids in analysis_asset_ids.items():
        missing = sorted(asset_ids.difference(cumulative_ids[category]))
        if missing:
            errors.append(
                f"单集分析中的 {category} 尚未同步到 {CATEGORY_FILES[category]}：{', '.join(missing)}"
            )

    world_path = registry / "世界观记录.json"
    world = load_json(world_path, "世界观记录.json", errors)
    world_names: set[str] = set()
    validated_world_records: list[dict[str, str]] | None = None
    world_records_value = world.get("records") if isinstance(world, dict) else None
    if (
        not isinstance(world, dict)
        or set(world) != {"records"}
        or not isinstance(world_records_value, list)
    ):
        if world is not None:
            errors.append("世界观记录.json 必须是包含 records 数组的对象")
    else:
        world_records = world["records"]
        world_structure_valid = bool(world_records)
        canonical_world_records: list[dict[str, str]] = []
        if not world_records:
            errors.append("全项目交付至少需要一条稳定世界观事实")
        for index, record in enumerate(world_records, start=1):
            location = f"世界观记录.records[{index}]"
            if not isinstance(record, dict):
                errors.append(f"{location}: 必须是对象")
                world_structure_valid = False
                continue
            extra = sorted(set(record).difference(WORLD_FIELD_ORDER))
            if extra:
                errors.append(f"{location}: 含未定义字段 {', '.join(extra)}")
                world_structure_valid = False
            for field in WORLD_FIELD_ORDER:
                if not clean_text(record.get(field)):
                    errors.append(f"{location}.{field} 不能为空")
                    world_structure_valid = False
            item = clean_text(record.get("item"))
            content = clean_text(record.get("content"))
            if item and content:
                quality_issues = world_fact_quality_issues(item, content)
                if quality_issues:
                    world_structure_valid = False
                    for issue in quality_issues:
                        errors.append(f"{location}: 世界观质量不合格：{issue}")
            if complete_world_record(record):
                canonical_world_records.append(
                    {"item": record["item"], "content": record["content"]}
                )
            if item:
                key = normalize(item)
                if key in world_names:
                    errors.append(f"世界观记录存在重复 item“{item}”")
                    world_structure_valid = False
                world_names.add(key)
                latest_analysis = analysis_world_latest.get(key)
                if latest_analysis is not None:
                    compare_record_fields(
                        record,
                        latest_analysis,
                        WORLD_FIELD_ORDER,
                        f"世界观记录 / {item}",
                        errors,
                    )
        missing_world = set(analysis_world_latest).difference(world_names)
        if missing_world:
            errors.append("单集分析中的世界观增量尚未同步：" + "、".join(sorted(missing_world)))
        stale_world = world_names.difference(analysis_world_latest)
        if stale_world:
            errors.append(
                "世界观累计记录含未在任何当前单集分析中出现的条目："
                + "、".join(sorted(stale_world))
            )
        if world_structure_valid and len(canonical_world_records) == len(world_records):
            validated_world_records = canonical_world_records

    validate_world_overview(
        cache,
        analysis_complete=analysis_complete,
        fact_records=validated_world_records,
        errors=errors,
    )
    asset_facts.sort(key=lambda item: (
        list(CATEGORY_FILES).index(str(item["category"])),
        int(item["firstRequiredEpisode"]),
        int(item["firstRequiredOrder"]),
        str(item["assetId"]),
    ))
    validate_visual_spec_progress(cache, asset_facts, set(asset_id_owners), errors)

    pending = load_json(cache / "待确认记录.json", "待确认记录.json", errors)
    if not isinstance(pending, list):
        if pending is not None:
            errors.append("待确认记录.json 顶层必须是数组")
    else:
        for index, record in enumerate(pending, start=1):
            validate_pending_record(
                record,
                index,
                discovered,
                asset_id_owners,
                all_asset_names,
                asset_ids_by_name,
                errors,
            )

    if not errors:
        end_snapshot = validation_snapshot(root)
        if end_snapshot != start_snapshot:
            errors.append("校验输入在校验过程中发生变化，请重新运行校验")
        else:
            write_validation_receipt(root, end_snapshot)
    if errors:
        receipt_path.unlink(missing_ok=True)
    result = {"ok": not errors, "records": total, "errors": errors}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


def main() -> int:
    if len(sys.argv) != 2:
        return validate_locked()
    root_arg = sys.argv[1]
    try:
        root, _ = validate_root_and_sources(root_arg)
    except Exception:
        return validate_locked()
    cache = root / "cache"
    lock = acquire_pipeline_lock(
        cache,
        "asset_records_validate",
        "asset_records",
        lease_mode="transient",
    )
    try:
        recover_pending_transaction(cache)
        return validate_locked()
    finally:
        release_pipeline_lock(cache, lock)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "records": 0, "errors": [f"校验器运行失败：{exc}"]},
                ensure_ascii=False,
                indent=2,
            )
        )
        raise SystemExit(1) from None
