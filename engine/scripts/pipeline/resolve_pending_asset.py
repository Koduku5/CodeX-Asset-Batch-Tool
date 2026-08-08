"""Commit one human identity decision and finalize staged assets when all are resolved.

The script is deliberately deterministic.  It never infers a merge, name, alias, or
category.  Human-reviewed records arrive on stdin; the last unresolved decision
triggers one compact asset-ID pass before any downstream visual/workbook artifacts
exist.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))
PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from pipeline_protocol import (  # noqa: E402
    ProtocolError,
    acquire_pipeline_lock,
    release_pipeline_lock,
)
from pending_asset_resolution import (  # noqa: E402
    UserError,
    clean_text,
    fail,
    parse_payload,
    submit_decision,
)
from source_manifest_protocol import validate_root_and_sources  # noqa: E402
def main() -> None:
    if len(sys.argv) != 2:
        fail("用法：resolve_pending_asset.py <skill-root>（人工决定从 stdin 读取）")
    root, _ = validate_root_and_sources(sys.argv[1])
    payload = parse_payload()
    cache = root / "cache"
    lock = acquire_pipeline_lock(
        cache,
        "pending_resolution",
        clean_text(payload.get("pendingId")),
        lease_mode="transient",
    )
    try:
        result = submit_decision(root, payload)
    finally:
        release_pipeline_lock(cache, lock)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (UserError, ProtocolError) as exc:
        print(f"错误：待确认资产处理失败：{exc}", file=sys.stderr)
        raise SystemExit(1)
