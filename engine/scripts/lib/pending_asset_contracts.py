"""Input, prerequisite, and asset-record contracts for pending decisions."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from sync_episode_analysis import CATEGORY_FILES, clean_text, validate_asset_record


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
