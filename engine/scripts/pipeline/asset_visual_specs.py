"""Prepare and atomically commit one final asset visual specification at a time."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from pipeline_protocol import (  # noqa: E402
    ProtocolError,
    acquire_pipeline_lock,
    atomic_write_json,
    read_json,
    recover_pending_transaction,
    release_pipeline_lock,
    transactional_commit_json,
)
from source_manifest_protocol import (  # noqa: E402
    build_source_manifest,
    validate_root_and_sources,
)
from world_records_protocol import (  # noqa: E402
    RECEIPT_FIELDS,
    canonical_sha256,
    facts_fingerprint,
    validate_fact_library,
)


CATEGORY_FILES = {
    "characters": "角色记录.json",
    "creatures": "生物记录.json",
    "extras": "群演记录.json",
    "scenes": "场景记录.json",
    "props": "道具记录.json",
}
CATEGORY_LABELS = {
    "characters": "角色",
    "creatures": "生物",
    "extras": "群演",
    "scenes": "场景",
    "props": "道具",
}
FACTION_CATEGORIES = {"characters", "creatures", "extras"}
FACT_FIELDS = (
    "assetId",
    "assetName",
    "scriptSetting",
    "aliases",
    "firstRequiredEpisode",
    "firstRequiredOrder",
)
PROGRESS_VERSION = 1
MAX_TEXT_LENGTH = 32767


class VisualSpecError(Exception):
    pass


def fail(message: str) -> None:
    raise VisualSpecError(message)


def now_text() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def read_required_json(path: Path, label: str) -> object:
    if not path.is_file() or path.is_symlink():
        fail(f"缺少安全的{label}")
    try:
        return read_json(path)
    except ProtocolError as exc:
        fail(f"{label}不可用：{exc}")


def validate_analysis_complete(progress: object) -> dict[str, object]:
    if not isinstance(progress, dict):
        fail("阅读进度.json 顶层必须是对象")
    discovered = progress.get("discoveredEpisodes")
    completed = progress.get("completedEpisodes")
    if (
        progress.get("status") != "complete"
        or not isinstance(discovered, list)
        or not discovered
        or any(type(item) is not int or item < 1 for item in discovered)
        or len(set(discovered)) != len(discovered)
        or completed != discovered
        or progress.get("currentEpisode") is not None
    ):
        fail("必须先完成整部剧本的逐集分析与累计")
    return progress


def validate_sources(root: Path, source_files: list[Path], progress: dict[str, object], *, full: bool) -> None:
    expected = progress.get("sourceManifest")
    if not isinstance(expected, list) or not expected:
        fail("阅读进度缺少有效 sourceManifest")
    if full:
        actual = build_source_manifest(source_files)
        if actual != expected:
            fail("剧本来源已经变化，请重新切分并分析")
        return
    expected_summary = [
        {"name": item.get("name"), "size": item.get("size")}
        for item in expected
        if isinstance(item, dict)
    ]
    actual_summary = [{"name": path.name, "size": path.stat().st_size} for path in source_files]
    if actual_summary != expected_summary:
        fail("剧本来源在视觉规格回填期间发生变化")


def validate_overview(cache: Path) -> tuple[dict[str, object], str]:
    world = read_required_json(cache / "累计记录" / "世界观记录.json", "世界观记录")
    records = validate_fact_library(world, fail=fail)
    fact_fingerprint = facts_fingerprint(records)
    pagination = read_required_json(cache / "世界观分页进度.json", "世界观分页进度")
    if (
        not isinstance(pagination, dict)
        or set(pagination) != RECEIPT_FIELDS
        or pagination.get("complete") is not True
        or pagination.get("nextOffset") is not None
        or pagination.get("factsFingerprint") != fact_fingerprint
    ):
        fail("世界观分页尚未完整完成或已经失效")
    overview = read_required_json(cache / "世界观总览.json", "世界观总览")
    if (
        not isinstance(overview, dict)
        or overview.get("version") != 2
        or not clean_text(overview.get("content"))
        or len(overview["content"]) > MAX_TEXT_LENGTH
        or overview.get("factsFingerprint") != fact_fingerprint
        or overview.get("coverageFingerprint") != canonical_sha256(pagination)
    ):
        fail("必须先完成并正式确认全剧世界观总览")
    return overview, canonical_sha256(overview)


def assert_pending_assets_finalized(cache: Path) -> None:
    value = read_required_json(cache / "待确认记录.json", "待确认记录")
    if not isinstance(value, list):
        fail("待确认记录.json 顶层必须是数组")
    blockers = [
        item
        for item in value
        if isinstance(item, dict)
        and (
            clean_text(item.get("status")) == "pending"
            or (
                isinstance(item.get("draftAsset"), dict)
                and not clean_text(item.get("appliedAt"))
            )
        )
    ]
    if blockers:
        fail(f"仍有 {len(blockers)} 项资产尚未完成人工确认与正式纳入，禁止生成视觉规格")


def validate_asset_record(record: object, category: str, index: int) -> dict[str, object]:
    location = f"{CATEGORY_FILES[category]}[{index}]"
    if not isinstance(record, dict):
        fail(f"{location} 必须是对象")
    required = set(FACT_FIELDS) | {"productionNotes", "inferenceBasis"}
    if category in FACTION_CATEGORIES:
        required.add("faction")
    if set(record) != required:
        fail(f"{location} 字段结构不符合累计资产协议")
    for field in ("assetId", "assetName", "scriptSetting"):
        text = clean_text(record.get(field))
        if not text or len(text) > MAX_TEXT_LENGTH:
            fail(f"{location}.{field} 必须是有效非空字符串")
    aliases = record.get("aliases")
    if not isinstance(aliases, list) or any(not isinstance(item, str) for item in aliases):
        fail(f"{location}.aliases 必须是字符串数组")
    for field in ("firstRequiredEpisode", "firstRequiredOrder"):
        if type(record.get(field)) is not int or record[field] < 1:
            fail(f"{location}.{field} 必须是正整数")
    if category in FACTION_CATEGORIES and not clean_text(record.get("faction")):
        fail(f"{location}.faction 不能为空")
    for field in ("productionNotes", "inferenceBasis"):
        value = record.get(field)
        if value is not None and (not isinstance(value, str) or len(value) > MAX_TEXT_LENGTH):
            fail(f"{location}.{field} 必须是字符串或 null")
    return dict(record)


def load_assets(cache: Path) -> tuple[dict[str, list[dict[str, object]]], list[dict[str, object]]]:
    registry = cache / "累计记录"
    by_category: dict[str, list[dict[str, object]]] = {}
    facts: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    for category, filename in CATEGORY_FILES.items():
        value = read_required_json(registry / filename, filename)
        if not isinstance(value, list):
            fail(f"{filename} 顶层必须是数组")
        records = [validate_asset_record(item, category, index) for index, item in enumerate(value, start=1)]
        by_category[category] = records
        for record in records:
            asset_id = clean_text(record["assetId"])
            if asset_id in seen_ids:
                fail(f"累计资产存在重复 assetId：{asset_id}")
            seen_ids.add(asset_id)
            fact = {
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
            facts.append(fact)
    facts.sort(key=lambda item: (
        list(CATEGORY_FILES).index(str(item["category"])),
        int(item["firstRequiredEpisode"]),
        int(item["firstRequiredOrder"]),
        str(item["assetId"]),
    ))
    return by_category, facts


def load_state(root: Path, *, full_source_check: bool) -> dict[str, object]:
    root, source_files = validate_root_and_sources(str(root))
    cache = root / "cache"
    recover_pending_transaction(cache)
    reading = validate_analysis_complete(read_required_json(cache / "阅读进度.json", "阅读进度"))
    validate_sources(root, source_files, reading, full=full_source_check)
    overview, overview_fingerprint = validate_overview(cache)
    assert_pending_assets_finalized(cache)
    by_category, asset_facts = load_assets(cache)
    return {
        "root": root,
        "cache": cache,
        "overview": overview,
        "overviewFingerprint": overview_fingerprint,
        "assets": by_category,
        "assetFacts": asset_facts,
        "assetFactsFingerprint": canonical_sha256(asset_facts),
    }


def progress_path(state: dict[str, object]) -> Path:
    return Path(state["cache"]) / "视觉规格回填进度.json"


def validate_saved_progress(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("version") != PROGRESS_VERSION:
        fail("视觉规格回填进度格式无效")
    required = {
        "version", "status", "overviewFingerprint", "assetFactsFingerprint", "total",
        "completedAssetIds", "current", "startedAt", "updatedAt", "completedAt",
    }
    if set(value) != required:
        fail("视觉规格回填进度字段结构无效")
    if value.get("status") == "not_started":
        return None
    if value.get("status") not in {"in_progress", "complete"}:
        fail("视觉规格回填进度状态无效")
    if not isinstance(value.get("completedAssetIds"), list):
        fail("视觉规格回填完成列表无效")
    return dict(value)


def read_saved_progress(state: dict[str, object]) -> dict[str, object] | None:
    path = progress_path(state)
    if not path.exists():
        return None
    return validate_saved_progress(read_required_json(path, "视觉规格回填进度"))


def new_progress(state: dict[str, object]) -> dict[str, object]:
    timestamp = now_text()
    total = len(state["assetFacts"])
    return {
        "version": PROGRESS_VERSION,
        "status": "complete" if total == 0 else "in_progress",
        "overviewFingerprint": state["overviewFingerprint"],
        "assetFactsFingerprint": state["assetFactsFingerprint"],
        "total": total,
        "completedAssetIds": [],
        "current": None,
        "startedAt": timestamp,
        "updatedAt": timestamp,
        "completedAt": timestamp if total == 0 else None,
    }


def progress_matches(progress: dict[str, object], state: dict[str, object]) -> bool:
    return (
        progress.get("overviewFingerprint") == state["overviewFingerprint"]
        and progress.get("assetFactsFingerprint") == state["assetFactsFingerprint"]
        and progress.get("total") == len(state["assetFacts"])
    )


def run_start(root: Path) -> dict[str, object]:
    state = load_state(root, full_source_check=True)
    saved = read_saved_progress(state)
    progress = saved if saved is not None and progress_matches(saved, state) else new_progress(state)
    valid_ids = {item["assetId"] for item in state["assetFacts"]}
    completed = progress.get("completedAssetIds", [])
    if len(set(completed)) != len(completed) or any(item not in valid_ids for item in completed):
        fail("视觉规格回填完成列表与当前资产不一致")
    if progress.get("status") == "complete" and len(completed) != len(valid_ids):
        fail("视觉规格回填完成状态与完成数量不一致")
    atomic_write_json(progress_path(state), progress)
    return {
        "ok": True,
        "done": progress["status"] == "complete",
        "completed": len(completed),
        "total": progress["total"],
    }


def run_next(root: Path) -> dict[str, object]:
    state = load_state(root, full_source_check=False)
    progress = read_saved_progress(state)
    if progress is None or not progress_matches(progress, state):
        fail("视觉规格回填输入已经变化，请重新启动该阶段")
    completed = set(progress["completedAssetIds"])
    if progress["status"] == "complete":
        return {"ok": True, "done": True, "completed": len(completed), "total": progress["total"]}
    asset = next((item for item in state["assetFacts"] if item["assetId"] not in completed), None)
    if asset is None:
        fail("视觉规格回填进度缺少完成状态")
    request_token = canonical_sha256({
        "overviewFingerprint": state["overviewFingerprint"],
        "assetFactsFingerprint": state["assetFactsFingerprint"],
        "asset": asset,
    })
    timestamp = now_text()
    current = {
        "category": asset["category"],
        "categoryLabel": CATEGORY_LABELS[str(asset["category"])],
        "assetId": asset["assetId"],
        "assetName": asset["assetName"],
        "requestToken": request_token,
        "startedAt": timestamp,
    }
    progress = {**progress, "current": current, "updatedAt": timestamp}
    atomic_write_json(progress_path(state), progress)
    return {
        "ok": True,
        "done": False,
        "completed": len(completed),
        "total": progress["total"],
        "requestToken": request_token,
        "worldOverview": state["overview"]["content"],
        "asset": asset,
    }


def parse_commit_payload() -> dict[str, str]:
    try:
        value = json.load(sys.stdin)
    except (OSError, json.JSONDecodeError):
        fail("视觉规格回填结果不是有效 JSON")
    required = {"requestToken", "assetId", "productionNotes", "inferenceBasis"}
    if not isinstance(value, dict) or set(value) != required:
        fail("视觉规格回填结果字段结构无效")
    result: dict[str, str] = {}
    for field in required:
        text = clean_text(value.get(field))
        if not text or len(text) > MAX_TEXT_LENGTH:
            fail(f"视觉规格回填结果.{field} 必须是有效非空字符串")
        result[field] = text
    return result


def run_commit(root: Path, payload: dict[str, str]) -> dict[str, object]:
    state = load_state(root, full_source_check=False)
    progress = read_saved_progress(state)
    if progress is None or not progress_matches(progress, state) or progress.get("status") != "in_progress":
        fail("视觉规格回填进度已经失效")
    current = progress.get("current")
    if (
        not isinstance(current, dict)
        or current.get("assetId") != payload["assetId"]
        or current.get("requestToken") != payload["requestToken"]
    ):
        fail("视觉规格回填结果与当前资产不匹配")
    category = current.get("category")
    if category not in CATEGORY_FILES:
        fail("视觉规格回填当前资产类别无效")
    records = state["assets"][category]
    matches = [index for index, item in enumerate(records) if item.get("assetId") == payload["assetId"]]
    if len(matches) != 1:
        fail("无法唯一定位视觉规格回填资产")
    index = matches[0]
    records[index] = {
        **records[index],
        "productionNotes": payload["productionNotes"],
        "inferenceBasis": payload["inferenceBasis"],
    }
    completed = list(progress["completedAssetIds"])
    if payload["assetId"] not in completed:
        completed.append(payload["assetId"])
    done = len(completed) == progress["total"]
    timestamp = now_text()
    updated_progress = {
        **progress,
        "status": "complete" if done else "in_progress",
        "completedAssetIds": completed,
        "current": None,
        "updatedAt": timestamp,
        "completedAt": timestamp if done else None,
    }
    registry_path = Path(state["cache"]) / "累计记录" / CATEGORY_FILES[category]
    transactional_commit_json(
        Path(state["cache"]),
        "asset_visual_spec_commit",
        {registry_path: records, progress_path(state): updated_progress},
    )
    return {
        "ok": True,
        "done": done,
        "assetId": payload["assetId"],
        "category": category,
        "categoryLabel": CATEGORY_LABELS[category],
        "completed": len(completed),
        "total": updated_progress["total"],
    }


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in {"start", "next", "commit"}:
        fail("用法：asset_visual_specs.py <project-root> <start|next|commit>")
    root = Path(sys.argv[1]).expanduser().resolve()
    cache = root / "cache"
    lock = acquire_pipeline_lock(
        cache,
        "asset_visual_specs",
        "visual_specs",
        lease_mode="transient",
    )
    try:
        command = sys.argv[2]
        if command == "start":
            result = run_start(root)
        elif command == "next":
            result = run_next(root)
        else:
            result = run_commit(root, parse_commit_payload())
        print(json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        release_pipeline_lock(cache, lock)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from None
