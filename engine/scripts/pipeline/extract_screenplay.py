import hashlib
import json
import re
import stat
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from docx import Document
from docx.table import Table

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from pipeline_protocol import (  # noqa: E402
    ProtocolError,
    acquire_pipeline_lock,
    recover_pending_transaction,
    release_pipeline_lock,
    transactional_commit_json,
)
from source_manifest_protocol import (  # noqa: E402
    MAX_SOURCE_FILE_BYTES,
    UserError,
    build_source_manifest,
    validate_root_and_sources,
)


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


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise UserError(f"Cache 文件格式损坏：{path}（第 {exc.lineno} 行）") from None
    except OSError as exc:
        raise UserError(f"无法读取 Cache 文件：{path}（{exc}）") from None


def value_has_data(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return bool(value.strip()) and value not in {"not_started", "idle", "ready"}
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, list):
        return bool(value)
    if isinstance(value, dict):
        return any(value_has_data(item) for item in value.values())
    return True


def cache_has_project_data(cache_dir: Path) -> bool:
    if not cache_dir.exists():
        return False
    if not cache_dir.is_dir():
        raise UserError(f"Cache 路径不是文件夹：{cache_dir}")
    for path in cache_dir.rglob("*"):
        if not path.is_file() or path.name.endswith(".tmp"):
            continue
        if path.name in {
            ".pipeline.lock",
            ".pipeline.operation.lock",
            ".pipeline.api.guard",
            ".pipeline.transaction.json",
            ".validation_receipt.json",
        }:
            continue
        if path.is_relative_to(cache_dir / ".pipeline-transactions"):
            continue
        # Prompt preferences may be saved before the first screenplay import.
        # They are production settings, not evidence that a screenplay project
        # has already populated this Cache.
        if path == cache_dir / "内置提示词预设.json":
            continue
        # Folder redraw is an independent API workspace. Its blank schema and
        # completed history do not identify the screenplay currently loaded in
        # this Skill, so they must not trigger the cross-screenplay Cache guard.
        if path.is_relative_to(cache_dir / "批量重绘"):
            continue
        if path.parent.name in {"单集原文", "单集分析"} and path.suffix.casefold() == ".json":
            return True
        if path.suffix.casefold() != ".json":
            if path.stat().st_size:
                return True
            continue
        value = read_json(path)
        if path.name == "阅读进度.json" and isinstance(value, dict):
            if any(
                value_has_data(value.get(field))
                for field in (
                    "sources",
                    "sourceManifest",
                    "discoveredEpisodes",
                    "completedEpisodes",
                    "currentEpisode",
                )
            ):
                return True
            if value.get("status") not in {None, "", "not_started", "idle"}:
                return True
            continue
        if path.name == "世界观记录.json" and isinstance(value, dict):
            if value_has_data(value.get("records")):
                return True
            continue
        if path.name == "世界观分页进度.json" and isinstance(value, dict):
            empty_pagination = {
                "factsFingerprint": "",
                "totalRecords": 0,
                "pageSize": 40,
                "coveredOffsets": [],
                "nextOffset": 0,
                "complete": False,
            }
            if value != empty_pagination:
                return True
            continue
        if path.name in {"出图队列.json", "出图进度.json"} and isinstance(value, dict):
            if value_has_data(value.get("items")):
                return True
            continue
        if value_has_data(value):
            return True
    return False


def validate_existing_cache(cache_dir: Path, manifest: list[dict[str, object]]) -> dict[str, object]:
    progress_path = cache_dir / "阅读进度.json"
    has_data = cache_has_project_data(cache_dir)
    if not progress_path.exists():
        if has_data:
            raise UserError("检测到非空 Cache，但缺少阅读进度.json。请先运行“清空Cache.cmd”后再切分剧本。")
        return {}

    progress = read_json(progress_path)
    if not isinstance(progress, dict):
        raise UserError("阅读进度.json 顶层必须是对象。请先运行“清空Cache.cmd”重置。")
    previous_manifest = progress.get("sourceManifest")
    if previous_manifest is None:
        if has_data:
            raise UserError("检测到旧版非空 Cache，尚无剧本指纹。请先运行“清空Cache.cmd”后再继续。")
        return progress
    if previous_manifest != manifest and has_data:
        raise UserError("当前剧本与 Cache 中记录的剧本不一致。为避免混入旧资产，请先运行“清空Cache.cmd”。")
    return progress


def run_locked(skill_root: Path, files: list[Path], cache_dir: Path) -> None:
    manifest = build_source_manifest(files)
    previous_progress = validate_existing_cache(cache_dir, manifest)
    previous_started_at = previous_progress.get("pipelineStartedAt")
    pipeline_started_at = (
        previous_started_at.strip()
        if isinstance(previous_started_at, str) and previous_started_at.strip()
        else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )

    discovered: dict[int, dict[str, object]] = {}
    fallback_episode = 1
    total_paragraphs = 0
    total_characters = 0
    for source in files:
        paragraphs = read_docx(source) if source.suffix.casefold() == ".docx" else read_txt(source)
        if not paragraphs:
            raise UserError(f"剧本“{source.name}”没有可读取的正文")
        total_paragraphs += len(paragraphs)
        total_characters += sum(len(paragraph) for paragraph in paragraphs)
        if total_paragraphs > MAX_TOTAL_PARAGRAPHS:
            raise UserError(f"剧本正文超过 {MAX_TOTAL_PARAGRAPHS} 段安全上限")
        if total_characters > MAX_TOTAL_TEXT_CHARACTERS:
            raise UserError(f"剧本正文超过 {MAX_TOTAL_TEXT_CHARACTERS} 字符安全上限")
        episodes = split_episodes(paragraphs)
        if not episodes:
            filename_match = EPISODE_RE.match(source.stem)
            if filename_match:
                fallback = chinese_number(filename_match.group(1))
            else:
                while fallback_episode in discovered:
                    fallback_episode += 1
                fallback = fallback_episode
            episodes = [(fallback, source.stem, paragraphs)]
        for episode, title, episode_paragraphs in episodes:
            if episode < 1:
                raise UserError(f"剧本“{source.name}”包含无效集数：{episode}")
            if episode in discovered:
                prior = discovered[episode]["source"]
                raise UserError(f"重复集数：第{episode}集同时存在于“{prior}”与“{source.name}”")
            discovered[episode] = {
                "source": source.name,
                "episode": episode,
                "title": title,
                "effectiveParagraphs": len(episode_paragraphs),
                "paragraphs": episode_paragraphs,
            }
            if len(discovered) > MAX_DISCOVERED_EPISODES:
                raise UserError(f"切分结果超过 {MAX_DISCOVERED_EPISODES} 集安全上限")
    if not discovered:
        raise UserError("没有从剧本中切分出任何可处理内容")
    _, current_files = validate_root_and_sources(str(skill_root))
    if build_source_manifest(current_files) != manifest:
        raise UserError("剧本文件在切分过程中发生变化，请关闭编辑窗口后重新运行")

    raw_dir = cache_dir / "单集原文"
    analysis_dir = cache_dir / "单集分析"
    registry_dir = cache_dir / "累计记录"
    for directory in (raw_dir, analysis_dir, registry_dir):
        directory.mkdir(parents=True, exist_ok=True)

    target_values: dict[Path, object] = {
        raw_dir / f"第{episode:03d}集.json": record
        for episode, record in sorted(discovered.items())
    }
    episode_manifest = [
        {
            "episode": episode,
            "sha256": canonical_json_sha256(record),
        }
        for episode, record in sorted(discovered.items())
    ]
    expected_files = {f"第{episode:03d}集.json" for episode in discovered}
    stale_paths = tuple(
        stale_path
        for stale_path in raw_dir.glob("第*集.json")
        if stale_path.name not in expected_files
    )

    defaults = {
        "世界观记录.json": {"records": []},
        "角色记录.json": [],
        "生物记录.json": [],
        "群演记录.json": [],
        "场景记录.json": [],
        "道具记录.json": [],
    }
    for name, value in defaults.items():
        path = registry_dir / name
        if not path.exists():
            target_values[path] = value
    overview_path = cache_dir / "世界观总览.json"
    if not overview_path.exists():
        target_values[overview_path] = {"content": ""}
    pending_path = cache_dir / "待确认记录.json"
    if not pending_path.exists():
        target_values[pending_path] = []
    pagination_path = cache_dir / "世界观分页进度.json"
    if not pagination_path.exists():
        target_values[pagination_path] = {
            "factsFingerprint": "",
            "totalRecords": 0,
            "pageSize": 40,
            "coveredOffsets": [],
            "nextOffset": 0,
            "complete": False,
        }
    for name, value in {
        "出图队列.json": {"version": 4, "items": []},
        "出图进度.json": {"version": 3, "items": {}},
    }.items():
        path = cache_dir / name
        if not path.exists():
            target_values[path] = value

    completed_value = previous_progress.get("completedEpisodes", [])
    completed = (
        sorted({item for item in completed_value if type(item) is int and item in discovered})
        if isinstance(completed_value, list)
        else []
    )
    for episode in completed:
        old_raw_path = raw_dir / f"第{episode:03d}集.json"
        old_analysis_path = analysis_dir / f"第{episode:03d}集.json"
        try:
            old_raw = read_json(old_raw_path)
            old_analysis = read_json(old_analysis_path)
        except (OSError, UserError):
            raise UserError(
                f"第{episode}集已标记完成，但旧原文或分析缺失；请先备份并运行“清空Cache.cmd”后重新分析"
            ) from None
        if canonical_json_sha256(old_raw) != canonical_json_sha256(discovered[episode]):
            raise UserError(
                f"第{episode}集切分结果与已完成分析绑定的旧原文不一致；禁止静默沿用，请先备份并清空 Cache 后重新分析"
            )
        assets = old_analysis.get("assets") if isinstance(old_analysis, dict) else None
        if not isinstance(assets, dict) or set(assets) != {
            "characters",
            "creatures",
            "extras",
            "scenes",
            "props",
        }:
            raise UserError(
                f"第{episode}集属于旧四类或结构不完整的分析，不能安全假定没有生物；请先备份并清空 Cache 后重新分析"
            )
    status = "complete" if len(completed) == len(discovered) else "in_progress" if completed else "ready"
    _, current_files = validate_root_and_sources(str(skill_root))
    if build_source_manifest(current_files) != manifest:
        raise UserError("剧本文件在切分写入期间发生变化，请清空 Cache 后重新运行")
    target_values[cache_dir / "阅读进度.json"] = {
        "sources": [path.name for path in files],
        "sourceManifest": manifest,
        "episodeManifest": episode_manifest,
        "discoveredEpisodes": sorted(discovered),
        "completedEpisodes": completed,
        "lastCompletedEpisode": max(completed) if completed else None,
        "currentEpisode": None,
        "currentStartedAt": None,
        "currentSessionToken": None,
        "currentResumedAt": None,
        "pipelineStartedAt": pipeline_started_at,
        "status": status,
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    transactional_commit_json(
        cache_dir,
        "screenplay_extract",
        target_values,
        delete_paths=stale_paths,
    )
    print(json.dumps({"ok": True, "sources": len(files), "episodes": sorted(discovered)}, ensure_ascii=False))


def main() -> None:
    if len(sys.argv) != 2:
        raise UserError("用法：extract_screenplay.py <skill-root>")

    # 根目录和输入先只读校验；随后持有独占锁完成来源复核、切分与全部写入。
    skill_root, files = validate_root_and_sources(sys.argv[1])
    cache_dir = skill_root / "cache"
    lock = acquire_pipeline_lock(
        cache_dir,
        "screenplay_extract",
        "screenplay",
        lease_mode="transient",
    )
    try:
        recover_pending_transaction(cache_dir)
        run_locked(skill_root, files, cache_dir)
    finally:
        release_pipeline_lock(cache_dir, lock)


if __name__ == "__main__":
    try:
        main()
    except (UserError, ProtocolError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"错误：切分剧本失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
