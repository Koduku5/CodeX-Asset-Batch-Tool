import json
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from pipeline_protocol import (  # noqa: E402
    ProtocolError,
    atomic_write_json,
    read_json,
    require_pipeline_lock,
)


MAX_ANALYSIS_BYTES = 1024 * 1024
EXPECTED_KEYS = {"source", "episode", "scriptAnalysis", "assets", "exclusions"}


class UserError(Exception):
    pass


def fail(message: str) -> None:
    raise UserError(message)


def main() -> None:
    if len(sys.argv) != 3:
        fail("用法：write_episode_analysis.py <project-root> <episode>")
    root = Path(sys.argv[1]).resolve(strict=True)
    if not root.is_dir():
        fail("项目根不是普通目录")
    try:
        episode = int(sys.argv[2])
    except ValueError:
        fail("episode 必须是正整数")
    if episode < 1:
        fail("episode 必须是正整数")

    cache = root / "cache"
    progress = read_json(cache / "阅读进度.json")
    if not isinstance(progress, dict):
        fail("阅读进度顶层必须是对象")
    token = progress.get("currentSessionToken")
    if (
        progress.get("status") != "in_progress"
        or progress.get("currentEpisode") != episode
        or not isinstance(token, str)
        or not token.strip()
    ):
        fail(f"第{episode}集尚未由固定 worker 执行 start/resume")
    require_pipeline_lock(
        cache,
        kind="analysis_episode",
        key=f"episode:{episode}",
        token=token,
    )

    payload = sys.stdin.buffer.read(MAX_ANALYSIS_BYTES + 1)
    if not payload or len(payload) > MAX_ANALYSIS_BYTES:
        fail(f"单集分析必须为 1 到 {MAX_ANALYSIS_BYTES} 字节")
    try:
        analysis = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("单集分析不是有效 UTF-8 JSON")
    if not isinstance(analysis, dict) or set(analysis) != EXPECTED_KEYS:
        fail("单集分析字段必须且只能包含 source、episode、scriptAnalysis、assets、exclusions")
    if analysis.get("episode") != episode:
        fail(f"单集分析 episode 必须为 {episode}")
    raw = read_json(cache / "单集原文" / f"第{episode:03d}集.json")
    raw_source = raw.get("source") if isinstance(raw, dict) else None
    if (
        not isinstance(raw_source, str)
        or not raw_source.strip()
        or raw.get("episode") != episode
    ):
        fail("当前单集原文来源元数据无效")

    # source is local provenance metadata, not an Agent-authored semantic field.
    # Always bind it to the locked episode snapshot before the atomic write.
    analysis["source"] = raw_source

    target = cache / "单集分析" / f"第{episode:03d}集.json"
    atomic_write_json(target, analysis)
    print(json.dumps({"ok": True, "episode": episode}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (UserError, ProtocolError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
