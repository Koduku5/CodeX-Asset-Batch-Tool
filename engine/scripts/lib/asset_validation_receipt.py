"""Stable input snapshots and receipts for asset delivery validation."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from asset_record_validation import VALIDATION_RECEIPT_VERSION, VALIDATOR_PROTOCOL_VERSION
from pipeline_protocol import atomic_write_json
from world_records_protocol import canonical_sha256


def validation_input_paths(root: Path) -> list[Path]:
    cache = root / "cache"
    fixed = [
        cache / "阅读进度.json",
        cache / "待确认记录.json",
        cache / "世界观分页进度.json",
        cache / "世界观总览.json",
        cache / "视觉规格回填进度.json",
        cache / "累计记录" / "世界观记录.json",
        cache / "累计记录" / "角色记录.json",
        cache / "累计记录" / "生物记录.json",
        cache / "累计记录" / "群演记录.json",
        cache / "累计记录" / "场景记录.json",
        cache / "累计记录" / "道具记录.json",
    ]
    discovered = []
    try:
        progress = json.loads((cache / "阅读进度.json").read_text(encoding="utf-8-sig"))
        if isinstance(progress, dict) and isinstance(progress.get("discoveredEpisodes"), list):
            discovered = [
                value
                for value in progress["discoveredEpisodes"]
                if type(value) is int and value > 0
            ]
    except (OSError, json.JSONDecodeError):
        pass
    episode_paths = [
        cache / directory / f"第{episode:03d}集.json"
        for episode in discovered
        for directory in ("单集原文", "单集分析")
    ]
    sources = []
    screenplay = root / "剧本"
    if screenplay.is_dir():
        sources = sorted(
            (
                path
                for path in screenplay.iterdir()
                if path.is_file()
                and not path.name.startswith("~$")
                and path.suffix.casefold() in {".docx", ".txt"}
            ),
            key=lambda path: path.name.casefold(),
        )
    return sorted(
        {path.resolve(strict=False) for path in (*sources, *fixed, *episode_paths)},
        key=lambda path: path.as_posix().casefold(),
    )


def stable_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            after_handle = os.fstat(handle.fileno())
        after_path = path.stat()
    except OSError as exc:
        raise RuntimeError(f"无法稳定读取校验输入：{path}（{exc}）") from None
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if any(
        getattr(before, field, None) != getattr(after_handle, field, None)
        or getattr(before, field, None) != getattr(after_path, field, None)
        for field in stable_fields
    ):
        raise RuntimeError(f"校验输入在计算指纹期间发生变化：{path}")
    return digest.hexdigest()


def validation_snapshot(root: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    resolved_root = root.resolve()
    for path in validation_input_paths(root):
        try:
            relative = path.relative_to(resolved_root).as_posix()
        except ValueError:
            raise RuntimeError(f"校验输入越出 Skill 根目录：{path}") from None
        files.append(
            {
                "path": relative,
                "sha256": stable_file_sha256(path) if path.is_file() else "missing",
            }
        )
    return files


def write_validation_receipt(root: Path, snapshot: list[dict[str, str]]) -> None:
    atomic_write_json(
        root / "cache" / ".validation_receipt.json",
        {
            "version": VALIDATION_RECEIPT_VERSION,
            "validatorProtocolVersion": VALIDATOR_PROTOCOL_VERSION,
            "snapshotFingerprint": canonical_sha256({"files": snapshot}),
            "files": snapshot,
            "validatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
    )
