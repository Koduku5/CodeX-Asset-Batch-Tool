"""Validate the complete asset delivery and write a stable validation receipt."""

from __future__ import annotations

import json
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from asset_delivery_analysis import validate_analysis_delivery  # noqa: E402
from asset_record_validation import (  # noqa: E402
    ASSET_FIELD_ORDER,
    CATEGORY_FILES,
    FACTION_CATEGORIES,
    SUBJECT_CATEGORIES,
    WORLD_FIELD_ORDER,
    compare_record_fields,
    complete_world_record,
    normalize,
    same_subject_form_family,
    validate_asset_structure,
    validate_pending_record,
)
from asset_validation_receipt import validation_snapshot, write_validation_receipt  # noqa: E402
from delivery_validation_support import clean_text, load_json  # noqa: E402
from pipeline_protocol import (  # noqa: E402
    acquire_pipeline_lock,
    recover_pending_transaction,
    release_pipeline_lock,
)
from source_manifest_protocol import (  # noqa: E402
    build_source_manifest,
    validate_root_and_sources,
)
from world_delivery_validation import (  # noqa: E402
    validate_visual_spec_progress,
    validate_world_overview,
)
from world_records_protocol import world_fact_quality_issues  # noqa: E402


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

    analysis = validate_analysis_delivery(root, source_manifest, errors)
    analysis_complete = analysis.analysis_complete
    discovered = analysis.discovered
    analysis_world_latest = analysis.analysis_world_latest
    analysis_asset_ids = analysis.analysis_asset_ids
    analysis_asset_latest = analysis.analysis_asset_latest
    analysis_first = analysis.analysis_first

    cumulative_ids: dict[str, set[str]] = {
        category: set() for category in CATEGORY_FILES
    }
    cumulative_name_keys: dict[str, set[str]] = {
        category: set() for category in CATEGORY_FILES
    }
    total = 0
    people_names: dict[str, str] = {}
    identity_owners: dict[str, dict[str, dict[str, object]]] = {
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
                if prior and not same_subject_form_family(record, prior):
                    prior_name = clean_text(prior.get("assetName"))
                    errors.append(
                        f"{identity_label}名称或别名冲突：“{name}”与“{prior_name}”共享“{identity}”"
                    )
                identity_owners[identity_group][key] = record
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
