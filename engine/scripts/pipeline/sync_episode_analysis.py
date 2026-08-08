import hashlib
import json
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
from asset_record_validation import (  # noqa: E402
    ASSET_ID_PREFIXES,
    ASSET_ID_RE,
    CATEGORY_FILES,
    FACTION_CATEGORIES,
    normalize,
)
from episode_asset_merge import (  # noqa: E402
    EpisodeAssetMergeError,
    assign_asset_ids,
    defer_identity_conflicts,
    ensure_asset_ids_unique,
    ensure_no_exact_identity_conflicts,
    ensure_order_unique,
    merge_by_name,
    protect_first_requirement,
)


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
    except (UserError, SourceUserError, ProtocolError, EpisodeAssetMergeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"错误：同步单集分析失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
