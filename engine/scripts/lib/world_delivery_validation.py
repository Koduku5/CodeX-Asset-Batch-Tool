from __future__ import annotations

from pathlib import Path

from delivery_validation_support import load_json, valid_iso_timestamp
from world_records_protocol import (
    FINGERPRINT_RE,
    PAGE_SIZE as WORLD_PAGE_SIZE,
    RECEIPT_FIELDS as WORLD_RECEIPT_FIELDS,
    canonical_sha256,
    facts_fingerprint as world_facts_fingerprint,
    world_overview_quality_issues,
)


WORLD_OVERVIEW_FIELDS = {
    "version",
    "content",
    "factsFingerprint",
    "coverageFingerprint",
    "finalizedAt",
}
VISUAL_PROGRESS_FIELDS = {
    "version",
    "status",
    "overviewFingerprint",
    "assetFactsFingerprint",
    "total",
    "completedAssetIds",
    "current",
    "startedAt",
    "updatedAt",
    "completedAt",
}


def validate_world_overview(
    cache: Path,
    *,
    analysis_complete: bool,
    fact_records: list[dict[str, str]] | None,
    errors: list[str],
) -> None:
    receipt = load_json(cache / "世界观分页进度.json", "世界观分页进度.json", errors)
    expected_fingerprint = (
        world_facts_fingerprint(fact_records) if fact_records is not None else None
    )
    coverage_fingerprint: str | None = None
    receipt_fingerprint: str | None = None
    if not isinstance(receipt, dict) or set(receipt) != WORLD_RECEIPT_FIELDS:
        if receipt is not None:
            errors.append("世界观分页进度.json 字段不完整或含未定义字段")
    else:
        receipt_valid = True
        fingerprint = receipt.get("factsFingerprint")
        total = receipt.get("totalRecords")
        page_size = receipt.get("pageSize")
        covered = receipt.get("coveredOffsets")
        next_offset = receipt.get("nextOffset")
        complete = receipt.get("complete")
        if not isinstance(fingerprint, str) or not FINGERPRINT_RE.fullmatch(fingerprint):
            errors.append("世界观分页进度.factsFingerprint 必须是小写 SHA-256")
            receipt_valid = False
        else:
            receipt_fingerprint = fingerprint
        if type(total) is not int or total < 1:
            errors.append("世界观分页进度.totalRecords 必须是正整数")
            receipt_valid = False
        if page_size != WORLD_PAGE_SIZE:
            errors.append(f"世界观分页进度.pageSize 必须等于 {WORLD_PAGE_SIZE}")
            receipt_valid = False
        if (
            not isinstance(covered, list)
            or any(type(item) is not int or item < 0 for item in covered)
            or covered != sorted(set(covered))
        ):
            errors.append("世界观分页进度.coveredOffsets 必须是不重复的升序非负整数数组")
            receipt_valid = False
            covered = []
        if complete is not True:
            errors.append("世界观分页进度.complete 必须为 true")
            receipt_valid = False
        if next_offset is not None:
            errors.append("世界观分页完成后 nextOffset 必须为 null")
            receipt_valid = False
        if type(total) is int and total > 0 and isinstance(covered, list):
            expected_offsets = list(range(0, total, WORLD_PAGE_SIZE))
            if covered != expected_offsets:
                errors.append(
                    "世界观分页进度.coveredOffsets 未完整覆盖事实库："
                    f"应为 {expected_offsets}"
                )
                receipt_valid = False
        if fact_records is not None:
            if total != len(fact_records):
                errors.append("世界观分页进度.totalRecords 与当前事实库数量不一致")
                receipt_valid = False
            if fingerprint != expected_fingerprint:
                errors.append("世界观分页进度.factsFingerprint 与当前事实库不一致")
                receipt_valid = False
        if receipt_valid:
            coverage_fingerprint = canonical_sha256(receipt)

    overview = load_json(cache / "世界观总览.json", "世界观总览.json", errors)
    if overview is None:
        return
    if not analysis_complete:
        if not isinstance(overview, dict) or set(overview) != {"content"}:
            errors.append("全剧分析未完成时，世界观总览.json 必须是未提交的 content 草稿")
            return
        content = overview.get("content")
        if not isinstance(content, str):
            errors.append("世界观总览.content 必须是字符串")
        elif content.strip():
            errors.append("全剧分析尚未完成，世界观总览.content 必须为空")
        return

    if not isinstance(overview, dict) or set(overview) != WORLD_OVERVIEW_FIELDS:
        errors.append("全剧分析完成后，世界观总览.json 必须是 finalize 生成的 version 2 对象")
        return
    if overview.get("version") != 2:
        errors.append("世界观总览.version 必须等于 2")
    content = overview.get("content")
    if not isinstance(content, str):
        errors.append("世界观总览.content 必须是字符串")
    elif not content.strip():
        errors.append("全剧分析完成后，世界观总览.content 不能为空，请生成世界观总览")
    else:
        for issue in world_overview_quality_issues(
            content,
            len(fact_records) if fact_records is not None else 0,
        ):
            errors.append(f"世界观总览.content 质量不合格：{issue}")
    overview_fingerprint = overview.get("factsFingerprint")
    if (
        not isinstance(overview_fingerprint, str)
        or not FINGERPRINT_RE.fullmatch(overview_fingerprint)
    ):
        errors.append("世界观总览.factsFingerprint 必须是小写 SHA-256")
    else:
        if expected_fingerprint is not None and overview_fingerprint != expected_fingerprint:
            errors.append("世界观总览.factsFingerprint 与当前事实库不一致")
        if receipt_fingerprint is not None and overview_fingerprint != receipt_fingerprint:
            errors.append("世界观总览.factsFingerprint 与分页凭证不一致")
    overview_coverage = overview.get("coverageFingerprint")
    if not isinstance(overview_coverage, str) or not FINGERPRINT_RE.fullmatch(overview_coverage):
        errors.append("世界观总览.coverageFingerprint 必须是小写 SHA-256")
    elif coverage_fingerprint is not None and overview_coverage != coverage_fingerprint:
        errors.append("世界观总览.coverageFingerprint 与完整分页凭证不一致")


def validate_visual_spec_progress(
    cache: Path,
    asset_facts: list[dict[str, object]],
    asset_ids: set[str],
    errors: list[str],
) -> None:
    overview = load_json(cache / "世界观总览.json", "世界观总览.json", errors)
    progress = load_json(cache / "视觉规格回填进度.json", "视觉规格回填进度.json", errors)
    if not isinstance(overview, dict) or set(overview) != WORLD_OVERVIEW_FIELDS:
        return
    if not isinstance(progress, dict) or set(progress) != VISUAL_PROGRESS_FIELDS:
        if progress is not None:
            errors.append("视觉规格回填进度.json 字段不完整或含未定义字段")
        return
    if progress.get("version") != 1:
        errors.append("视觉规格回填进度.version 必须等于 1")
    if progress.get("status") != "complete":
        errors.append("视觉规格回填尚未完成")
    expected_overview = canonical_sha256(overview)
    expected_assets = canonical_sha256(asset_facts)
    if progress.get("overviewFingerprint") != expected_overview:
        errors.append("视觉规格回填进度与当前世界观总览不一致")
    if progress.get("assetFactsFingerprint") != expected_assets:
        errors.append("视觉规格回填进度与当前累计资产事实不一致")
    total = progress.get("total")
    if type(total) is not int or total != len(asset_facts):
        errors.append("视觉规格回填进度.total 与当前资产数量不一致")
    completed = progress.get("completedAssetIds")
    if (
        not isinstance(completed, list)
        or any(not isinstance(item, str) or not item.strip() for item in completed)
        or len(set(completed)) != len(completed)
        or set(completed) != asset_ids
    ):
        errors.append("视觉规格回填完成列表必须与当前全部资产完全一致")
    if progress.get("current") is not None:
        errors.append("视觉规格回填完成后 current 必须为 null")
    for field in ("startedAt", "updatedAt", "completedAt"):
        if not valid_iso_timestamp(progress.get(field)):
            errors.append(f"视觉规格回填进度.{field} 必须是带时区的 ISO 时间")
    if not valid_iso_timestamp(overview.get("finalizedAt")):
        errors.append("世界观总览.finalizedAt 必须是带时区的 ISO 时间")
