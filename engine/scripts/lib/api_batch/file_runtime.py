"""Filesystem, fingerprint and conflict-safe output primitives for API batches."""

from __future__ import annotations

import hashlib
import json
import os
import stat as stat_module
import threading
import time
import uuid
from pathlib import Path

from api_batch.progress_store import clean_text
from api_batch.remote_client import OutputConflictError


_SKILL_ROOT = Path('.')
_IMAGE_OUTPUT_ROOT = Path('.')
_DIRECTORY_REDRAW_MODE = False
_DIRECTORY_REDRAW_OUTPUT_ROOT: Path | None = None
_REFERENCE_HASH_CACHE: dict[tuple[str, int, int], str] = {}
_REFERENCE_HASH_MUTEX = threading.Lock()


def configure_file_runtime(*, skill_root: Path, image_output_root: Path,
                           directory_redraw_mode: bool) -> None:
    global _SKILL_ROOT, _IMAGE_OUTPUT_ROOT, _DIRECTORY_REDRAW_MODE
    _SKILL_ROOT = skill_root
    _IMAGE_OUTPUT_ROOT = image_output_root
    _DIRECTORY_REDRAW_MODE = directory_redraw_mode


def set_directory_redraw_output_root(output_root: Path) -> None:
    global _DIRECTORY_REDRAW_OUTPUT_ROOT
    _DIRECTORY_REDRAW_OUTPUT_ROOT = output_root


def stable_file_sha256(path: Path, initial_stat=None) -> tuple[str, os.stat_result]:
    stat = initial_stat or path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    final_stat = path.stat()
    if (final_stat.st_size, final_stat.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        raise OSError(f"文件在校验期间发生变化：{path}")
    return digest.hexdigest(), stat

def normalize_prompt_text(value) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def json_fingerprint(payload: dict) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_fingerprint(payload) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


_MISSING = object()


def read_json(path: Path, fallback=_MISSING):
    try:
        with path.open(encoding="utf-8-sig") as source:
            return json.load(source)
    except FileNotFoundError:
        if fallback is not _MISSING:
            return fallback
        raise


def write_json_atomic(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        for attempt in range(4):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 3:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)


def resolve_output(relative_path: str) -> Path:
    if not clean_text(relative_path):
        raise ValueError("queue item outputPath is empty")
    candidate = Path(relative_path)
    if _DIRECTORY_REDRAW_MODE:
        root = _DIRECTORY_REDRAW_OUTPUT_ROOT
        if root is None:
            raise ValueError("directory redraw output root is not configured")
        target = (root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    else:
        root = _IMAGE_OUTPUT_ROOT
        target = (_SKILL_ROOT / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    try:
        common = Path(os.path.commonpath([str(target), str(root)]))
    except ValueError as error:
        raise ValueError(f"output path escapes configured output root: {relative_path}") from error
    if os.path.normcase(str(common)) != os.path.normcase(str(root)):
        raise ValueError(f"output path escapes configured output root: {relative_path}")
    return target


def is_within(path: Path, root: Path) -> bool:
    try:
        common = Path(os.path.commonpath([str(path.resolve()), str(root.resolve())]))
    except ValueError:
        return False
    return os.path.normcase(str(common)) == os.path.normcase(str(root.resolve()))


def is_reparse_or_symlink(path: Path) -> bool:
    info = os.lstat(path)
    attributes = int(getattr(info, "st_file_attributes", 0) or 0)
    reparse_flag = int(getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0) or 0)
    return stat_module.S_ISLNK(info.st_mode) or bool(reparse_flag and attributes & reparse_flag)


def require_stable_real_directory(path: Path, label: str) -> Path:
    declared = Path(os.path.abspath(path))
    if not declared.is_dir():
        raise SystemExit(f"{label}不存在：{declared}")
    if is_reparse_or_symlink(declared):
        raise SystemExit(f"{label}不能是符号链接或目录联接：{declared}")
    resolved = declared.resolve()
    if os.path.normcase(str(resolved)) != os.path.normcase(str(declared)):
        raise SystemExit(f"{label}真实路径已变化，请重新建立批量重绘队列：{declared}")
    return resolved


def reject_reparse_segments(root: Path, parts: tuple[str, ...], label: str) -> None:
    current = root
    for part in parts:
        current = current / part
        try:
            if is_reparse_or_symlink(current):
                raise SystemExit(f"{label}不能经过符号链接或目录联接：{current}")
        except FileNotFoundError:
            break


def cached_file_sha256(path: Path) -> str:
    stat = path.stat()
    key = (os.path.normcase(str(path.resolve())), stat.st_size, stat.st_mtime_ns)
    with _REFERENCE_HASH_MUTEX:
        cached = _REFERENCE_HASH_CACHE.get(key)
    if cached:
        return cached
    digest, _ = stable_file_sha256(path, stat)
    with _REFERENCE_HASH_MUTEX:
        stale = [entry for entry in _REFERENCE_HASH_CACHE if entry[0] == key[0]]
        for entry in stale:
            _REFERENCE_HASH_CACHE.pop(entry, None)
        _REFERENCE_HASH_CACHE[key] = digest
    return digest


def file_snapshot(path: Path) -> dict:
    try:
        digest, stat = stable_file_sha256(path)
    except FileNotFoundError:
        return {"exists": False}
    return {
        "exists": True,
        "size": stat.st_size,
        "mtimeMs": stat.st_mtime_ns / 1_000_000,
        "sha256": digest,
    }


def install_candidate_file_snapshot(path: Path) -> dict:
    """Return the content identity persisted before publishing a download."""
    digest, stat = stable_file_sha256(path)
    return {
        "size": stat.st_size,
        "sha256": digest,
    }


def normalize_install_candidate_snapshot(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    size = value.get("size")
    digest = value.get("sha256")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        return None
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        return None
    return {
        "size": size,
        "sha256": digest,
    }


def require_new_output_target(path: Path) -> dict:
    """Return the missing baseline required for a new remote submission."""
    try:
        path.lstat()
    except FileNotFoundError:
        return {"exists": False}
    raise OutputConflictError(f"目标文件已存在，禁止提交会覆盖它的远端任务：{path}")


def require_unchanged_missing_output_baseline(path: Path, baseline: object) -> dict:
    """Fail closed unless a recovery download is still bound to a missing target."""
    if not isinstance(baseline, dict) or type(baseline.get("exists")) is not bool:
        raise OutputConflictError(f"任务缺少可靠的提交前输出基线，禁止下载覆盖：{path}")
    try:
        current = file_snapshot(path)
    except (IsADirectoryError, OSError) as error:
        raise OutputConflictError(f"无法验证当前输出目标，禁止下载覆盖：{path}（{error}）") from error
    if current != baseline:
        raise OutputConflictError(f"输出目标在远端提交后发生变化，禁止下载覆盖：{path}")
    if current.get("exists") is True:
        raise OutputConflictError(f"远端提交前输出目标已存在，禁止下载覆盖：{path}")
    return current


def install_downloaded_file_without_overwrite(
    temporary: Path,
    output_path: Path,
    baseline: object,
) -> None:
    """Atomically publish a same-directory temporary file only when target is absent."""
    require_unchanged_missing_output_baseline(output_path, baseline)
    try:
        if os.name == "nt":
            # Windows rename is an atomic no-replace operation. Unlike hard links,
            # it also works on FAT/exFAT and many network-backed volumes.
            os.rename(temporary, output_path)
        else:
            # POSIX rename replaces an existing target, so retain link-based
            # no-replace publication there.
            os.link(temporary, output_path)
    except FileExistsError as error:
        raise OutputConflictError(f"结果文件在下载期间出现，已停止覆盖：{output_path}") from error
    except OSError as error:
        raise RuntimeError(f"无法以不覆盖方式安装结果图片：{output_path}（{error}）") from error

