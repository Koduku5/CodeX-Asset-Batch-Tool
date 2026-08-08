"""Cross-process lock and crash-recoverable Cache transaction helpers."""

from __future__ import annotations

import ctypes
import json
import os
import socket
import tempfile
import uuid
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path


LOCK_PROTOCOL_VERSION = 2


class ProtocolError(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def _windows_process_state(process_id: int) -> tuple[str, str | None]:
    query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(query_limited_information, False, process_id)
    if not handle:
        return ("dead", None) if ctypes.get_last_error() == 87 else ("unknown", None)
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return "unknown", None
        if exit_code.value != still_active:
            return "dead", None
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel_time = wintypes.FILETIME()
        user_time = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            return "unknown", None
        creation_ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        unix_seconds = (creation_ticks - 116444736000000000) / 10_000_000
        started = datetime.fromtimestamp(unix_seconds, timezone.utc)
        return "alive", started.isoformat().replace("+00:00", "Z")
    finally:
        kernel32.CloseHandle(handle)


def _process_state(process_id: int) -> tuple[str, str | None]:
    if os.name == "nt":
        return _windows_process_state(process_id)
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return "dead", None
    except (PermissionError, OSError):
        return "unknown", None
    return "alive", None


def _current_process_start_time() -> str:
    state, started = _process_state(os.getpid())
    return started if state == "alive" and started else _now()


CURRENT_PROCESS_START_TIME = _current_process_start_time()
CURRENT_HOST = socket.gethostname()


def process_metadata() -> dict[str, object]:
    return {
        "processId": os.getpid(),
        "processStartTime": CURRENT_PROCESS_START_TIME,
        "host": CURRENT_HOST,
    }


def _classify_owner(record: object, *, transient_required: bool = True) -> str:
    if not isinstance(record, dict):
        return "unknown"
    if record.get("protocolVersion") != LOCK_PROTOCOL_VERSION:
        return "unknown"
    if transient_required and record.get("leaseMode") != "transient":
        return "unknown"
    if record.get("host", "").casefold() != CURRENT_HOST.casefold():
        return "unknown"
    process_id = record.get("processId")
    expected_start = _parse_time(record.get("processStartTime"))
    if type(process_id) is not int or process_id < 1 or expected_start is None:
        return "unknown"
    state, actual_start_text = _process_state(process_id)
    if state != "alive":
        return state
    actual_start = _parse_time(actual_start_text)
    if actual_start is None:
        return "alive" if process_id == os.getpid() else "unknown"
    return (
        "alive"
        if abs((actual_start - expected_start).total_seconds()) <= 5
        else "identity_mismatch"
    )


def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"协议文件无法读取：{path}（{exc}）") from None


def _inside_cache(cache_dir: Path, target: Path) -> Path:
    cache = cache_dir.resolve()
    resolved = target.resolve(strict=False)
    try:
        return resolved.relative_to(cache)
    except ValueError:
        raise ProtocolError(f"事务目标超出 Cache：{target}") from None


def _is_reparse_point(path: Path) -> bool:
    try:
        stat_result = path.lstat()
    except OSError:
        return False
    return path.is_symlink() or bool(getattr(stat_result, "st_file_attributes", 0) & 0x400)


def _assert_safe_cache_root(cache_dir: Path) -> None:
    if not cache_dir.is_dir() or _is_reparse_point(cache_dir):
        raise ProtocolError(f"Cache 目录不存在、不是文件夹或属于重解析点：{cache_dir}")


def _safe_cache_path(cache_dir: Path, value: object, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError(f"事务日志缺少 {label}")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ProtocolError(f"事务日志 {label} 越出 Cache")
    _assert_safe_cache_root(cache_dir)
    cache = cache_dir.resolve()
    candidate = cache / relative
    raw_cursor = cache
    for part in relative.parts:
        raw_cursor /= part
        if _is_reparse_point(raw_cursor):
            raise ProtocolError(f"事务日志 {label} 不得经过链接或重解析点：{raw_cursor}")
    resolved_relative = _inside_cache(cache, candidate)
    cursor = cache
    for part in resolved_relative.parts:
        cursor /= part
        if _is_reparse_point(cursor):
            raise ProtocolError(f"事务日志 {label} 不得经过链接或重解析点：{cursor}")
    return cache / resolved_relative



def acquire_pipeline_lock(
    cache_dir: Path,
    kind: str,
    key: str,
    *,
    lease_mode: str = "durable",
    lock_name: str = ".pipeline.lock",
) -> dict[str, object]:
    if lease_mode not in {"durable", "transient"}:
        raise ProtocolError(f"未知锁模式：{lease_mode}")
    if cache_dir.exists() and _is_reparse_point(cache_dir):
        raise ProtocolError(f"Cache 目录不能是链接或重解析点：{cache_dir}")
    cache_dir.mkdir(parents=True, exist_ok=True)
    _assert_safe_cache_root(cache_dir)
    lock_path = cache_dir / lock_name
    now = _now()
    lock: dict[str, object] = {
        "protocolVersion": LOCK_PROTOCOL_VERSION,
        "kind": kind,
        "key": key,
        "leaseMode": lease_mode,
        "token": uuid.uuid4().hex,
        "createdAt": now,
        "updatedAt": now,
        **process_metadata(),
    }
    for attempt in range(2):
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            existing = read_json(lock_path)
            state = _classify_owner(existing)
            if attempt == 0 and state in {"dead", "identity_mismatch"}:
                if not isinstance(existing, dict) or not str(existing.get("token", "")).strip():
                    raise ProtocolError("流水线锁缺少令牌，禁止自动恢复") from None
                current = read_json(lock_path)
                if not isinstance(current, dict) or current.get("token") != existing.get("token"):
                    raise ProtocolError("流水线锁在恢复期间发生变化，禁止继续") from None
                quarantine = cache_dir / f"{lock_name}.stale.{existing['token']}.{uuid.uuid4().hex}"
                try:
                    os.replace(lock_path, quarantine)
                    quarantine.unlink(missing_ok=True)
                except OSError as exc:
                    raise ProtocolError(f"无法隔离陈旧流水线锁：{exc}") from None
                continue
            owner = (
                f"{existing.get('kind', 'unknown')}:{existing.get('key', 'unknown')}"
                if isinstance(existing, dict)
                else "unknown:unknown"
            )
            raise ProtocolError(f"已有流水线任务占用：{owner}") from None
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(lock, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            return lock
        except Exception:
            lock_path.unlink(missing_ok=True)
            raise
    raise ProtocolError("无法取得流水线锁")


def require_pipeline_lock(
    cache_dir: Path,
    *,
    kind: str,
    key: str,
    token: str | None = None,
    lock_name: str = ".pipeline.lock",
) -> dict[str, object]:
    _assert_safe_cache_root(cache_dir)
    lock_path = cache_dir / lock_name
    if not lock_path.is_file():
        raise ProtocolError("当前任务未持有流水线锁")
    lock = read_json(lock_path)
    if not isinstance(lock, dict) or lock.get("kind") != kind or lock.get("key") != key:
        owner = (
            f"{lock.get('kind', 'unknown')}:{lock.get('key', 'unknown')}"
            if isinstance(lock, dict)
            else "unknown:unknown"
        )
        raise ProtocolError(f"流水线锁不属于当前任务：{owner}")
    if token is not None and (not token.strip() or lock.get("token") != token):
        raise ProtocolError("流水线锁会话令牌与阅读进度不一致")
    return lock


def release_pipeline_lock(
    cache_dir: Path,
    expected: dict[str, object],
    *,
    lock_name: str = ".pipeline.lock",
) -> None:
    token = str(expected.get("token", "")).strip()
    if not token:
        raise ProtocolError("流水线锁缺少释放令牌，禁止自动删除")
    require_pipeline_lock(
        cache_dir,
        kind=str(expected.get("kind", "")),
        key=str(expected.get("key", "")),
        token=token,
        lock_name=lock_name,
    )
    (cache_dir / lock_name).unlink()
