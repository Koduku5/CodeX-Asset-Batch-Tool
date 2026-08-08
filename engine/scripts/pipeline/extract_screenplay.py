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
    recover_pending_transaction,
    release_pipeline_lock,
    transactional_commit_json,
)
from source_manifest_protocol import (  # noqa: E402
    UserError,
    build_source_manifest,
    validate_root_and_sources,
)
from screenplay_cache import validate_existing_cache  # noqa: E402
from screenplay_sources import (  # noqa: E402
    EPISODE_RE,
    MAX_DISCOVERED_EPISODES,
    MAX_TOTAL_PARAGRAPHS,
    MAX_TOTAL_TEXT_CHARACTERS,
    canonical_json_sha256,
    read_docx,
    read_txt,
    split_episodes,
)


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
