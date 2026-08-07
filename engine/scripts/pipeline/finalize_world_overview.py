import json
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
from source_manifest_protocol import (  # noqa: E402
    UserError as SourceUserError,
    build_source_manifest,
    validate_root_and_sources,
)
from world_records_protocol import (  # noqa: E402
    FINGERPRINT_RE,
    PAGE_SIZE,
    RECEIPT_FIELDS,
    canonical_sha256,
    facts_fingerprint,
    validate_episode_list,
    validate_fact_library,
    world_overview_quality_issues,
)


class UserError(Exception):
    pass


FINAL_OVERVIEW_FIELDS = {
    "version",
    "content",
    "factsFingerprint",
    "coverageFingerprint",
    "finalizedAt",
}
MAX_EXCEL_CELL_CHARACTERS = 32_767


def fail(message: str) -> None:
    raise UserError(message)


def read_json(path: Path, label: str) -> object:
    if not path.is_file():
        fail(f"缺少{label}：{path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        fail(f"{label}不是有效 JSON：{path.name}（第 {exc.lineno} 行）")
    except OSError as exc:
        fail(f"无法读取{label}：{path}（{exc}）")


def clean_overview_content(value: object) -> str:
    if not isinstance(value, dict):
        fail("世界观总览.json 必须是 content 草稿或已提交的 version 2 对象")
    fields = set(value)
    if fields != {"content"} and fields != FINAL_OVERVIEW_FIELDS:
        fail("世界观总览.json 必须是 content 草稿或已提交的 version 2 对象")
    content = value.get("content")
    if not isinstance(content, str) or not content.strip():
        fail("世界观总览.content 必须是非空字符串")
    content = content.strip()
    if len(content) > MAX_EXCEL_CELL_CHARACTERS:
        fail(
            "世界观总览.content 超过 Excel 单元格 32767 字符上限，"
            "请在不丢失关键设定的前提下压缩总览后重试"
        )
    return content


def validate_complete_receipt(
    value: object,
    *,
    expected_fingerprint: str,
    total_records: int,
) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != RECEIPT_FIELDS:
        fail("世界观分页进度.json 字段不完整或含未定义字段，请从 offset 0 重新分页")
    fingerprint = value.get("factsFingerprint")
    total = value.get("totalRecords")
    page_size = value.get("pageSize")
    covered = value.get("coveredOffsets")
    next_offset = value.get("nextOffset")
    complete = value.get("complete")
    if not isinstance(fingerprint, str) or not FINGERPRINT_RE.fullmatch(fingerprint):
        fail("世界观分页进度.factsFingerprint 无效")
    if fingerprint != expected_fingerprint:
        fail("世界观分页凭证与当前事实库指纹不一致，必须从 offset 0 重新分页")
    if type(total) is not int or total != total_records:
        fail("世界观分页凭证的事实总数与当前事实库不一致，必须从 offset 0 重新分页")
    if page_size != PAGE_SIZE:
        fail(f"世界观分页凭证.pageSize 必须等于 {PAGE_SIZE}")
    if (
        not isinstance(covered, list)
        or any(type(item) is not int or item < 0 for item in covered)
        or covered != sorted(set(covered))
    ):
        fail("世界观分页凭证.coveredOffsets 无效")
    expected_offsets = list(range(0, total_records, PAGE_SIZE))
    if covered != expected_offsets:
        missing = sorted(set(expected_offsets).difference(covered))
        detail = f"，缺少 offset：{', '.join(map(str, missing))}" if missing else ""
        fail(f"世界观事实尚未完整分页覆盖{detail}")
    if complete is not True or next_offset is not None:
        fail("世界观分页尚未完成，complete 必须为 true 且 nextOffset 必须为 null")
    return value


def main() -> None:
    if len(sys.argv) != 2:
        fail("用法：finalize_world_overview.py <skill-root>")
    root, source_files = validate_root_and_sources(sys.argv[1])
    cache = root / "cache"
    lock = acquire_pipeline_lock(
        cache,
        kind="world_overview_finalize",
        key="world_overview",
        lease_mode="transient",
    )
    try:
        recover_pending_transaction(cache)
        source_manifest = build_source_manifest(source_files)
        progress = read_json(cache / "阅读进度.json", "阅读进度.json")
        if not isinstance(progress, dict):
            fail("阅读进度.json 顶层必须是对象")
        if progress.get("sourceManifest") != source_manifest:
            fail("剧本指纹与阅读进度不一致，请先重新切分或清空 Cache")
        if progress.get("status") != "complete":
            fail("全剧分析尚未完成，不能提交世界观总览")
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

        facts = read_json(
            cache / "累计记录" / "世界观记录.json",
            "世界观记录.json",
        )
        records = validate_fact_library(facts, fail=fail)
        fingerprint = facts_fingerprint(records)
        receipt = validate_complete_receipt(
            read_json(cache / "世界观分页进度.json", "世界观分页进度.json"),
            expected_fingerprint=fingerprint,
            total_records=len(records),
        )
        coverage_fingerprint = canonical_sha256(receipt)
        overview_path = cache / "世界观总览.json"
        content = clean_overview_content(read_json(overview_path, "世界观总览.json"))
        quality_issues = world_overview_quality_issues(content, len(records))
        if quality_issues:
            fail("世界观总览质量不合格：" + "；".join(quality_issues))
        _, current_source_files = validate_root_and_sources(str(root))
        if build_source_manifest(current_source_files) != source_manifest:
            fail("剧本文件在总览提交过程中发生变化，请重新综合后再提交")
        overview = {
            "version": 2,
            "content": content,
            "factsFingerprint": fingerprint,
            "coverageFingerprint": coverage_fingerprint,
            "finalizedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        atomic_write_json(overview_path, overview)
        print(
            json.dumps(
                {
                    "ok": True,
                    "contentLength": len(content),
                    "factsFingerprint": fingerprint,
                    "coverageFingerprint": coverage_fingerprint,
                },
                ensure_ascii=False,
            )
        )
    finally:
        release_pipeline_lock(cache, lock)


if __name__ == "__main__":
    try:
        main()
    except (UserError, SourceUserError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"错误：提交世界观总览失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
