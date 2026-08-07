import json
import sys
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
from source_manifest_protocol import (  # noqa: E402
    UserError as SourceUserError,
    build_source_manifest,
    validate_root_and_sources,
)
from world_records_protocol import (  # noqa: E402
    FINGERPRINT_RE,
    PAGE_SIZE,
    RECEIPT_FIELDS,
    facts_fingerprint,
    validate_episode_list,
    validate_fact_library,
)


class UserError(Exception):
    pass


def fail(message: str) -> None:
    raise UserError(message)


def parse_integer(value: str, label: str, *, minimum: int) -> int:
    try:
        result = int(value)
    except ValueError:
        fail(f"{label}必须是整数：{value}")
    if result < minimum:
        fail(f"{label}必须大于或等于 {minimum}")
    return result


def read_json(path: Path, label: str) -> object:
    if not path.is_file():
        fail(f"缺少{label}：{path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        fail(f"{label}不是有效 JSON（第 {exc.lineno} 行）")
    except OSError as exc:
        fail(f"无法读取{label}：{exc}")


def read_records(cache: Path) -> list[dict[str, str]]:
    value = read_json(cache / "累计记录" / "世界观记录.json", "世界观记录.json")
    return validate_fact_library(value, fail=fail)


def validate_receipt(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != RECEIPT_FIELDS:
        fail("世界观分页进度.json 字段不完整或含未定义字段，请从 offset 0 重新分页")
    fingerprint = value.get("factsFingerprint")
    total = value.get("totalRecords")
    page_size = value.get("pageSize")
    covered = value.get("coveredOffsets")
    next_offset = value.get("nextOffset")
    complete = value.get("complete")
    if not isinstance(fingerprint, str) or not FINGERPRINT_RE.fullmatch(fingerprint):
        fail("世界观分页进度.factsFingerprint 无效，请从 offset 0 重新分页")
    if type(total) is not int or total < 1:
        fail("世界观分页进度.totalRecords 必须是正整数，请从 offset 0 重新分页")
    if page_size != PAGE_SIZE:
        fail(f"世界观分页进度.pageSize 必须等于 {PAGE_SIZE}，请从 offset 0 重新分页")
    if (
        not isinstance(covered, list)
        or any(type(item) is not int or item < 0 for item in covered)
        or covered != sorted(set(covered))
    ):
        fail("世界观分页进度.coveredOffsets 无效，请从 offset 0 重新分页")
    if next_offset is not None and (type(next_offset) is not int or next_offset < 0):
        fail("世界观分页进度.nextOffset 无效，请从 offset 0 重新分页")
    if type(complete) is not bool:
        fail("世界观分页进度.complete 必须是布尔值，请从 offset 0 重新分页")
    return value


def validate_ready_progress(cache: Path, source_manifest: list[dict[str, object]]) -> None:
    progress = read_json(cache / "阅读进度.json", "阅读进度.json")
    if not isinstance(progress, dict):
        fail("阅读进度.json 顶层必须是对象")
    if progress.get("sourceManifest") != source_manifest:
        fail("剧本指纹与阅读进度不一致，请先重新切分或清空 Cache")
    if progress.get("status") != "complete":
        fail("全剧分析尚未完成，不能分页综合世界观")
    discovered = validate_episode_list(
        progress.get("discoveredEpisodes"),
        "阅读进度.discoveredEpisodes",
        fail=fail,
    )
    completed = validate_episode_list(
        progress.get("completedEpisodes"),
        "阅读进度.completedEpisodes",
        fail=fail,
    )
    if completed != discovered:
        fail("阅读进度.completedEpisodes 必须与 discoveredEpisodes 完全一致")
    if progress.get("currentEpisode") is not None:
        fail("阅读进度.currentEpisode 必须为空")


def main() -> None:
    if len(sys.argv) not in {3, 4}:
        fail("用法：page_world_records.py <skill-root> <offset> [limit]")
    root, source_files = validate_root_and_sources(sys.argv[1])
    offset = parse_integer(sys.argv[2], "offset", minimum=0)
    limit = parse_integer(sys.argv[3], "limit", minimum=1) if len(sys.argv) == 4 else PAGE_SIZE
    if limit != PAGE_SIZE:
        fail(f"世界观分页大小固定为 {PAGE_SIZE}，不得使用其他 limit")

    cache = root / "cache"
    lock = acquire_pipeline_lock(
        cache,
        kind="world_records_page",
        key=f"offset:{offset}",
        lease_mode="transient",
    )
    try:
        recover_pending_transaction(cache)
        source_manifest = build_source_manifest(source_files)
        validate_ready_progress(cache, source_manifest)
        records = read_records(cache)
        fingerprint = facts_fingerprint(records)
        receipt_path = cache / "世界观分页进度.json"

        if offset == 0:
            covered: list[int] = []
        else:
            receipt = validate_receipt(read_json(receipt_path, "世界观分页进度.json"))
            if receipt["factsFingerprint"] != fingerprint or receipt["totalRecords"] != len(records):
                fail("世界观事实库已变化，必须从 offset 0 重新分页")
            if receipt["complete"] or receipt["nextOffset"] is None:
                fail("世界观分页已经完成；如需重做，请从 offset 0 重新开始")
            if offset != receipt["nextOffset"]:
                fail(f"offset 必须严格等于分页凭证中的 nextOffset：{receipt['nextOffset']}")
            covered = list(receipt["coveredOffsets"])

        page = records[offset : offset + PAGE_SIZE]
        if not page:
            fail("offset 超出当前事实库范围；请按 nextOffset 顺序分页")
        next_offset = offset + len(page) if offset + len(page) < len(records) else None
        covered.append(offset)
        receipt = {
            "factsFingerprint": fingerprint,
            "totalRecords": len(records),
            "pageSize": PAGE_SIZE,
            "coveredOffsets": covered,
            "nextOffset": next_offset,
            "complete": next_offset is None,
        }
        atomic_write_json(receipt_path, receipt)

        _, current_source_files = validate_root_and_sources(str(root))
        if build_source_manifest(current_source_files) != source_manifest:
            fail("剧本文件在分页过程中发生变化，请重新切分或清空 Cache")
        result = {
            "total": len(records),
            "offset": offset,
            "nextOffset": next_offset,
            "factsFingerprint": fingerprint,
            "records": page,
        }
    finally:
        release_pipeline_lock(cache, lock)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (UserError, SourceUserError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"错误：分页读取世界观记录失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
