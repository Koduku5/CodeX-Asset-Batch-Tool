"""Shared pure helpers for the world-record paging protocol."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from typing import NoReturn


PAGE_SIZE = 40
FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
RECEIPT_FIELDS = {
    "factsFingerprint",
    "totalRecords",
    "pageSize",
    "coveredOffsets",
    "nextOffset",
    "complete",
}
WORLD_ITEM_SEPARATOR = "｜"
GENERIC_WORLD_ANCHORS = {
    "世界观",
    "世界背景",
    "背景设定",
    "故事背景",
    "剧情背景",
    "核心设定",
    "基本设定",
    "世界设定",
    "时代背景",
    "社会环境",
    "势力",
    "势力关系",
    "科技",
    "科技水平",
    "文化",
    "历史",
    "规则",
    "其他",
}
EPISODE_TRACE_RE = re.compile(
    r"(?:本集(?!团)|这一集|该集|上一集|下一集|"
    r"本(?:剧|故事|作品)(?:中|里)|第[0-9零〇一二三四五六七八九十百]+集(?!团))"
)
HOLLOW_OPENING_RE = re.compile(
    r"^(?:这是一个|这是个|本剧(?:主要)?(?:讲述|围绕|展现|描写)|"
    r"本故事(?:主要)?(?:讲述|围绕|展现|描写)|故事(?:主要)?(?:讲述|围绕))"
)
ANALYSIS_OPENING_RE = re.compile(r"^(?:体现了|反映了|展现了|揭示了|说明了)")
INTERNAL_TERM_RE = re.compile(
    r"(?:原子事实|世界观记录|世界观总览|资产设计|资产表|制作说明|Cache|缓存文件)"
)

FailureHandler = Callable[[str], NoReturn]


def _compact_text(value: str) -> str:
    return re.sub(r"[\s\W_]+", "", value, flags=re.UNICODE).casefold()


def world_fact_quality_issues(item: str, content: str) -> list[str]:
    """Return deterministic red-line violations; semantic completeness remains agent-reviewed."""
    issues: list[str] = []
    clean_item = item.strip()
    clean_content = content.strip()
    separator_count = clean_item.count(WORLD_ITEM_SEPARATOR)
    if separator_count > 1:
        issues.append("item 最多使用一个全角“｜”，推荐格式为“具体锚点｜规则维度”")
    elif separator_count == 1:
        anchor, dimension = (part.strip() for part in clean_item.split(WORLD_ITEM_SEPARATOR))
        if not anchor or not dimension:
            issues.append("item 的具体锚点和规则维度均不能为空")
        if _compact_text(anchor) in {_compact_text(value) for value in GENERIC_WORLD_ANCHORS}:
            issues.append(f"item 左侧“{anchor}”是泛化栏目，必须改为剧本中的具体锚点")
        if _compact_text(dimension) in {"设定", "介绍", "概述", "总结", "分析", "其他"}:
            issues.append(f"item 右侧“{dimension}”没有指出具体规则维度")
    elif _compact_text(clean_item) in {_compact_text(value) for value in GENERIC_WORLD_ANCHORS}:
        issues.append(f"item“{clean_item}”是泛化栏目，必须改为剧本中的具体锚点")
    if EPISODE_TRACE_RE.search(clean_item) or EPISODE_TRACE_RE.search(clean_content):
        issues.append("世界观事实不得包含集数、‘本集/本剧’等剧情或分析痕迹")
    if HOLLOW_OPENING_RE.search(clean_content):
        issues.append("content 不得以题材套话或剧情简介开头，必须直接陈述具体事实")
    if ANALYSIS_OPENING_RE.search(clean_content):
        issues.append("content 不得写主题评价，必须陈述世界内部真实成立的关系")
    if INTERNAL_TERM_RE.search(clean_content):
        issues.append("content 不得出现 Cache、原子事实、资产表或制作说明等内部工作术语")
    if clean_item and clean_content and _compact_text(clean_item) == _compact_text(clean_content):
        issues.append("content 不能只重复 item，必须写出完整规则或关系")
    return issues


def world_overview_quality_issues(content: str, fact_count: int) -> list[str]:
    """Return hard presentation failures before the overview becomes an Excel deliverable."""
    issues: list[str] = []
    clean_content = content.strip()
    if HOLLOW_OPENING_RE.search(clean_content):
        issues.append("总览不得以‘这是一个……的世界’或剧情简介开头")
    if EPISODE_TRACE_RE.search(clean_content):
        issues.append("总览不得出现集数、‘本集/本剧’等逐集或分析痕迹")
    if INTERNAL_TERM_RE.search(clean_content):
        issues.append("总览不得出现 Cache、原子事实、资产表或制作说明等内部工作术语")
    paragraphs = [
        _compact_text(part)
        for part in re.split(r"\n\s*\n", clean_content)
        if _compact_text(part)
    ]
    if len(paragraphs) != len(set(paragraphs)):
        issues.append("总览存在完全重复段落")
    return issues


def validate_episode_list(
    value: object,
    label: str,
    *,
    fail: FailureHandler,
) -> set[int]:
    if not isinstance(value, list) or not value:
        fail(f"{label}必须是非空数组")
    if any(type(item) is not int or item < 1 for item in value):
        fail(f"{label}只能包含正整数")
    if len(set(value)) != len(value):
        fail(f"{label}不得包含重复集数")
    return set(value)


def validate_fact_library(
    value: object,
    *,
    fail: FailureHandler,
) -> list[dict[str, str]]:
    if (
        not isinstance(value, dict)
        or set(value) != {"records"}
        or not isinstance(value.get("records"), list)
        or not value["records"]
    ):
        fail("世界观记录.json 必须是包含非空 records 数组的对象")
    records: list[dict[str, str]] = []
    for index, record in enumerate(value["records"], start=1):
        if not isinstance(record, dict) or set(record) != {"item", "content"}:
            fail(f"世界观记录.records[{index}] 必须且只能包含 item、content")
        for field in ("item", "content"):
            if not isinstance(record.get(field), str) or not record[field].strip():
                fail(f"世界观记录.records[{index}].{field} 必须是非空字符串")
        quality_issues = world_fact_quality_issues(record["item"], record["content"])
        if quality_issues:
            fail(f"世界观记录.records[{index}] 质量不合格：{'；'.join(quality_issues)}")
        records.append({"item": record["item"], "content": record["content"]})
    return records


def canonical_sha256(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def facts_fingerprint(records: list[dict[str, str]]) -> str:
    return canonical_sha256({"records": records})
