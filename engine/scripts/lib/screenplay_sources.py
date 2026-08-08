"""Validated TXT/DOCX screenplay readers and episode splitting."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath

from docx import Document
from docx.table import Table

from source_manifest_protocol import MAX_SOURCE_FILE_BYTES, UserError


EPISODE_RE = re.compile(
    r"^第\s*([0-9零〇一二两三四五六七八九十百]+)\s*集(?P<suffix>.*)$"
)
HEADING_SEPARATORS = "：:、.-—"
COMPACT_SENTENCE_ENDINGS = "。；;，,"
MAX_DOCX_ENTRIES = 20_000
MAX_DOCX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_DOCX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_DOCX_COMPRESSION_RATIO = 500
MAX_DISCOVERED_EPISODES = 10_000
MAX_TOTAL_PARAGRAPHS = 500_000
MAX_TOTAL_TEXT_CHARACTERS = 50_000_000


def canonical_json_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def validate_docx_container(path: Path) -> None:
    try:
        source_size = path.stat().st_size
    except OSError as exc:
        raise UserError(f"无法读取 Word 剧本“{path.name}”：{exc}") from None
    if source_size <= 0 or source_size > MAX_SOURCE_FILE_BYTES:
        raise UserError(f"Word 剧本“{path.name}”为空或超过 200 MiB 文件上限")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_DOCX_ENTRIES:
                raise UserError(f"Word 剧本“{path.name}”压缩包条目数量异常")
            total_size = 0
            names: set[str] = set()
            for info in entries:
                normalized = info.filename.replace("\\", "/")
                member = PurePosixPath(normalized)
                if (
                    not normalized
                    or member.is_absolute()
                    or ".." in member.parts
                    or normalized in names
                    or info.flag_bits & 0x1
                    or stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK
                ):
                    raise UserError(f"Word 剧本“{path.name}”包含不安全或重复的压缩条目")
                names.add(normalized)
                if info.is_dir():
                    continue
                if info.file_size < 0 or info.file_size > MAX_DOCX_MEMBER_BYTES:
                    raise UserError(f"Word 剧本“{path.name}”包含超过 256 MiB 的解压条目")
                total_size += info.file_size
                if total_size > MAX_DOCX_UNCOMPRESSED_BYTES:
                    raise UserError(f"Word 剧本“{path.name}”解压后总量超过 512 MiB")
                if info.file_size > 0 and (
                    info.compress_size <= 0
                    or info.file_size / info.compress_size > MAX_DOCX_COMPRESSION_RATIO
                ):
                    raise UserError(f"Word 剧本“{path.name}”包含异常压缩比条目")
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                raise UserError(f"Word 剧本“{path.name}”缺少 DOCX 必要结构")
    except UserError:
        raise
    except (OSError, zipfile.BadZipFile, NotImplementedError) as exc:
        raise UserError(f"无法读取 Word 剧本“{path.name}”：{exc}") from None


def chinese_number(value: str) -> int:
    if value.isdigit():
        return int(value)
    digits = {
        "零": 0,
        "〇": 0,
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    units = {"十": 10, "百": 100}
    if not any(char in units for char in value):
        try:
            return int("".join(str(digits[char]) if char in digits else char for char in value))
        except (KeyError, ValueError):
            raise UserError(f"无法识别集数：{value}") from None
    total = 0
    current = 0
    for char in value:
        if char in digits:
            current = digits[char]
        elif char.isdigit():
            current = int(char)
        elif char in units:
            total += (current or 1) * units[char]
            current = 0
        else:
            raise UserError(f"无法识别集数：{value}")
    return total + current


def read_docx(path: Path) -> list[str]:
    validate_docx_container(path)
    try:
        document = Document(path)
    except Exception as exc:
        raise UserError(f"无法读取 Word 剧本“{path.name}”：{exc}") from None
    lines: list[str] = []
    for block in document.iter_inner_content():
        if isinstance(block, Table):
            for row in block.rows:
                seen_cells = set()
                for cell in row.cells:
                    cell_id = id(cell._tc)
                    if cell_id in seen_cells:
                        continue
                    seen_cells.add(cell_id)
                    lines.extend(
                        text.strip()
                        for text in cell.text.splitlines()
                        if text.strip()
                    )
        else:
            text = block.text.strip()
            if text:
                lines.append(text)
    return lines


def read_txt(path: Path) -> list[str]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise UserError(f"无法读取文本剧本“{path.name}”：{exc}") from None
    if size <= 0 or size > MAX_SOURCE_FILE_BYTES:
        raise UserError(f"文本剧本“{path.name}”为空或超过 200 MiB 文件上限")
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            text = path.read_text(encoding=encoding)
            return [line.strip() for line in text.splitlines() if line.strip()]
        except UnicodeDecodeError:
            continue
        except OSError as exc:
            raise UserError(f"无法读取文本剧本“{path.name}”：{exc}") from None
    raise UserError(f"无法识别文本剧本“{path.name}”的编码")


def split_episodes(paragraphs: list[str]) -> list[tuple[int, str, list[str]]]:
    candidates: list[tuple[int, int, str, bool]] = []
    strict_episodes: set[int] = set()
    for index, text in enumerate(paragraphs):
        match = EPISODE_RE.match(text)
        if not match:
            continue
        episode = chinese_number(match.group(1))
        suffix = match.group("suffix")
        strict = not suffix or suffix[0].isspace() or suffix[0] in HEADING_SEPARATORS
        candidates.append((index, episode, text, strict))
        if strict:
            strict_episodes.add(episode)

    starts: list[tuple[int, int, str]] = []
    seen_compact: set[int] = set()
    for index, episode, text, strict in candidates:
        if not strict:
            if episode in strict_episodes or episode in seen_compact:
                continue
            if len(text) > 80 or text.endswith(tuple(COMPACT_SENTENCE_ENDINGS)):
                continue
            seen_compact.add(episode)
        starts.append((index, episode, text))
    if not starts:
        return []

    result: list[tuple[int, str, list[str]]] = []
    for position, (heading_index, episode, title) in enumerate(starts):
        # 第一集连同标题前的前言一起保存，避免世界观、背景和故事梗概丢失。
        start = 0 if position == 0 else heading_index
        end = starts[position + 1][0] if position + 1 < len(starts) else len(paragraphs)
        result.append((episode, title, paragraphs[start:end]))
    return result



