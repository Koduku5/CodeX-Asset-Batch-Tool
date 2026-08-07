"""剧本来源发现、根目录校验与来源指纹的共享实现。"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path


SOURCE_SUFFIXES = {".docx", ".txt"}
MAX_SOURCE_FILE_BYTES = 200 * 1024 * 1024
MAX_SOURCE_FILES = 1_000
MAX_TOTAL_SOURCE_BYTES = 1024 * 1024 * 1024


class UserError(Exception):
    """可直接展示给用户的输入或状态错误。"""


def _natural_key(path: Path) -> list[object]:
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", path.name)
    ]


def _stable_file_snapshot(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            if before.st_size <= 0 or before.st_size > MAX_SOURCE_FILE_BYTES:
                raise UserError(
                    f"剧本“{path.name}”为空或超过 200 MiB 安全上限，未计算指纹"
                )
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            after_handle = os.fstat(handle.fileno())
        after_path = path.stat()
    except OSError as exc:
        raise UserError(f"无法读取剧本“{path.name}”以计算指纹：{exc}") from None
    stable_fields = ("st_size", "st_mtime_ns", "st_dev", "st_ino")
    if any(
        getattr(before, field, None) != getattr(after_handle, field, None)
        or getattr(before, field, None) != getattr(after_path, field, None)
        for field in stable_fields
    ):
        raise UserError(f"剧本“{path.name}”在计算指纹期间发生变化")
    return before.st_size, digest.hexdigest()


def build_source_manifest(files: list[Path]) -> list[dict[str, object]]:
    """生成可稳定比较的剧本来源清单。"""
    manifest = []
    for path in files:
        size, fingerprint = _stable_file_snapshot(path)
        manifest.append({"name": path.name, "size": size, "sha256": fingerprint})
    return manifest


def validate_root_and_sources(skill_root_arg: str) -> tuple[Path, list[Path]]:
    """校验 Skill 根目录，并按自然顺序返回有效剧本文件。"""
    skill_root = Path(skill_root_arg).expanduser().resolve()
    if not skill_root.is_dir():
        raise UserError(f"Skill 根目录不存在或不是文件夹：{skill_root}")
    marker = skill_root / "scripts" / "pipeline" / "extract_screenplay.py"
    if not marker.is_file():
        raise UserError(f"目录不是有效的剧本资产 Skill（缺少 {marker}）")

    script_dir = skill_root / "剧本"
    if not script_dir.is_dir():
        raise UserError(f"缺少剧本文件夹：{script_dir}")
    script_dir_resolved = script_dir.resolve()
    try:
        entries = list(script_dir.iterdir())
    except OSError as exc:
        raise UserError(f"无法访问剧本文件夹：{exc}") from None

    files: list[Path] = []
    total_source_bytes = 0
    for path in entries:
        if (
            path.is_file()
            and path.suffix.casefold() in SOURCE_SUFFIXES
            and not path.name.startswith("~$")
        ):
            resolved = path.resolve()
            if resolved.parent != script_dir_resolved:
                raise UserError(f"剧本文件不得通过链接指向文件夹外部：{path.name}")
            try:
                size = resolved.stat().st_size
            except OSError as exc:
                raise UserError(f"无法读取剧本“{path.name}”的文件信息：{exc}") from None
            if size <= 0:
                raise UserError(f"剧本文件不能为空：{path.name}")
            if size > MAX_SOURCE_FILE_BYTES:
                raise UserError(
                    f"剧本文件超过 200 MiB 安全上限，未读取内容：{path.name}"
                )
            if len(files) >= MAX_SOURCE_FILES:
                raise UserError(f"剧本来源文件超过 {MAX_SOURCE_FILES} 个安全上限")
            total_source_bytes += size
            if total_source_bytes > MAX_TOTAL_SOURCE_BYTES:
                raise UserError("剧本来源文件总大小超过 1 GiB 安全上限")
            files.append(resolved)
    files.sort(key=_natural_key)
    if not files:
        raise UserError("剧本/ 中没有可读取的 .docx 或 .txt 文件")
    return skill_root, files
