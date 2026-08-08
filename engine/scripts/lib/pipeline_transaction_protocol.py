"""Crash-recoverable Cache transaction helpers."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from pipeline_lock_protocol import (
    LOCK_PROTOCOL_VERSION,
    ProtocolError,
    _assert_safe_cache_root,
    _classify_owner,
    _inside_cache,
    _is_reparse_point,
    _now,
    _safe_cache_path,
    atomic_write_json,
    process_metadata,
    read_json,
)


TRANSACTION_PROTOCOL_VERSION = 1


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _write_bytes_fsync(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def _replace_bytes_atomic(target: Path, value: bytes, label: str) -> None:
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{target.name}.{label}.", suffix=".tmp", dir=target.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    finally:
        try:
            os.unlink(temp_name)
        except OSError:
            pass


def _safe_stage_dir(cache_dir: Path, journal: dict[str, object]) -> Path:
    token = journal.get("token")
    if not isinstance(token, str) or not token.strip():
        raise ProtocolError("事务日志缺少 token")
    expected = Path(".pipeline-transactions") / token
    stage_value = journal.get("stageDir")
    if not isinstance(stage_value, str) or Path(stage_value) != expected:
        raise ProtocolError("事务日志 stageDir 与 token 不一致")
    return _safe_cache_path(cache_dir, stage_value, "stageDir")


def _entry_bytes(cache_dir: Path, journal: dict[str, object], entry: dict[str, object], field: str) -> bytes:
    relative = entry.get(field)
    path = _safe_cache_path(cache_dir, relative, field)
    stage = _safe_stage_dir(cache_dir, journal)
    try:
        path.relative_to(stage)
    except ValueError:
        raise ProtocolError(f"事务条目 {field} 不在本事务暂存目录中") from None
    try:
        return path.read_bytes()
    except OSError as exc:
        raise ProtocolError(f"事务暂存文件无法读取：{path}（{exc}）") from None


def _target_matches(cache_dir: Path, entry: dict[str, object], prefix: str) -> bool:
    target = _safe_cache_path(cache_dir, entry.get("target"), "target")
    exists = bool(entry[f"{prefix}Exists"])
    if not exists:
        return not target.exists()
    if not target.is_file():
        return False
    try:
        return _sha256_bytes(target.read_bytes()) == entry[f"{prefix}Sha256"]
    except OSError:
        return False


def _restore_before(cache_dir: Path, journal: dict[str, object]) -> None:
    entries = journal.get("entries")
    if not isinstance(entries, list):
        raise ProtocolError("事务日志 entries 无效")
    journal["phase"] = "rolling_back"
    journal["updatedAt"] = _now()
    atomic_write_json(cache_dir / ".pipeline.transaction.json", journal)
    for raw_entry in reversed(entries):
        if not isinstance(raw_entry, dict) or not isinstance(raw_entry.get("target"), str):
            raise ProtocolError("事务日志条目无效")
        target = _safe_cache_path(cache_dir, raw_entry.get("target"), "target")
        target.parent.mkdir(parents=True, exist_ok=True)
        if raw_entry.get("beforeExists"):
            data = _entry_bytes(cache_dir, journal, raw_entry, "before")
            if _sha256_bytes(data) != raw_entry.get("beforeSha256"):
                raise ProtocolError(f"事务回滚副本指纹不匹配：{target}")
            _replace_bytes_atomic(target, data, "rollback")
        else:
            target.unlink(missing_ok=True)
    if not all(_target_matches(cache_dir, entry, "before") for entry in entries):
        raise ProtocolError("事务回滚后的目标指纹校验失败")


def _cleanup_transaction(cache_dir: Path, journal: dict[str, object]) -> None:
    stage = _safe_stage_dir(cache_dir, journal)
    if stage.exists():
        expected_files: set[Path] = set()
        entries = journal.get("entries")
        if not isinstance(entries, list):
            raise ProtocolError("事务日志 entries 无效")
        for entry in entries:
            if not isinstance(entry, dict):
                raise ProtocolError("事务日志条目无效")
            for field in ("before", "after"):
                value = entry.get(field)
                if value is None:
                    continue
                item = _safe_cache_path(cache_dir, value, field)
                try:
                    item.relative_to(stage)
                except ValueError:
                    raise ProtocolError(f"事务条目 {field} 不在本事务暂存目录中") from None
                expected_files.add(item)
        actual_files = set(stage.iterdir())
        if actual_files != expected_files or any(not item.is_file() for item in actual_files):
            raise ProtocolError("事务暂存目录含未知内容，禁止递归删除")
        for item in actual_files:
            item.unlink()
        stage.rmdir()
    (cache_dir / ".pipeline.transaction.json").unlink(missing_ok=True)
    stage_root = cache_dir / ".pipeline-transactions"
    try:
        stage_root.rmdir()
    except OSError:
        pass


def recover_pending_transaction(cache_dir: Path) -> bool:
    _assert_safe_cache_root(cache_dir)
    journal_path = cache_dir / ".pipeline.transaction.json"
    if not journal_path.exists():
        return False
    journal = read_json(journal_path)
    if (
        not isinstance(journal, dict)
        or journal.get("protocolVersion") != TRANSACTION_PROTOCOL_VERSION
        or not isinstance(journal.get("token"), str)
        or journal.get("phase") not in {"prepared", "committing", "committed", "rolling_back"}
    ):
        raise ProtocolError("事务日志结构无效，禁止自动处理")
    owner = {
        **journal,
        "protocolVersion": LOCK_PROTOCOL_VERSION,
        "leaseMode": "transient",
    }
    state = _classify_owner(owner)
    if state == "alive":
        raise ProtocolError(f"事务仍由活动进程持有：{journal.get('kind', 'unknown')}")
    if state not in {"dead", "identity_mismatch"}:
        raise ProtocolError("无法确认事务进程已退出，禁止自动恢复")
    entries = journal.get("entries")
    if journal["phase"] == "committed" and isinstance(entries, list) and all(
        isinstance(entry, dict) and _target_matches(cache_dir, entry, "after") for entry in entries
    ):
        _cleanup_transaction(cache_dir, journal)
        return True
    _restore_before(cache_dir, journal)
    _cleanup_transaction(cache_dir, journal)
    return True


def transactional_commit_json(
    cache_dir: Path,
    kind: str,
    values: dict[Path, object],
    *,
    delete_paths: tuple[Path, ...] = (),
) -> None:
    _assert_safe_cache_root(cache_dir)
    recover_pending_transaction(cache_dir)
    token = uuid.uuid4().hex
    stage_relative = Path(".pipeline-transactions") / token
    stage = _safe_cache_path(cache_dir, stage_relative.as_posix(), "stageDir")
    targets: list[tuple[Path, bytes | None]] = [
        (path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        for path, value in values.items()
    ] + [(path, None) for path in delete_paths]
    if len({str(_inside_cache(cache_dir, path)).casefold() for path, _ in targets}) != len(targets):
        raise ProtocolError("事务包含重复目标")
    entries: list[dict[str, object]] = []
    stage.mkdir(parents=True, exist_ok=False)
    try:
        for index, (target, after_bytes) in enumerate(targets):
            relative_target = _inside_cache(cache_dir, target)
            before_bytes = target.read_bytes() if target.exists() else None
            before_name = f"{index:04d}.before" if before_bytes is not None else None
            after_name = f"{index:04d}.after" if after_bytes is not None else None
            if before_name:
                _write_bytes_fsync(stage / before_name, before_bytes)
            if after_name:
                _write_bytes_fsync(stage / after_name, after_bytes)
            entries.append(
                {
                    "target": relative_target.as_posix(),
                    "beforeExists": before_bytes is not None,
                    "before": (stage_relative / before_name).as_posix() if before_name else None,
                    "beforeSha256": _sha256_bytes(before_bytes) if before_bytes is not None else None,
                    "afterExists": after_bytes is not None,
                    "after": (stage_relative / after_name).as_posix() if after_name else None,
                    "afterSha256": _sha256_bytes(after_bytes) if after_bytes is not None else None,
                }
            )
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    now = _now()
    journal: dict[str, object] = {
        "protocolVersion": TRANSACTION_PROTOCOL_VERSION,
        "token": token,
        "kind": kind,
        "phase": "prepared",
        "createdAt": now,
        "updatedAt": now,
        **process_metadata(),
        "stageDir": stage_relative.as_posix(),
        "appliedCount": 0,
        "entries": entries,
    }
    journal_path = cache_dir / ".pipeline.transaction.json"
    try:
        atomic_write_json(journal_path, journal)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    try:
        journal["phase"] = "committing"
        atomic_write_json(journal_path, journal)
        for index, entry in enumerate(entries):
            target = _safe_cache_path(cache_dir, entry.get("target"), "target")
            target.parent.mkdir(parents=True, exist_ok=True)
            if entry["afterExists"]:
                data = _entry_bytes(cache_dir, journal, entry, "after")
                _replace_bytes_atomic(target, data, "commit")
            else:
                target.unlink(missing_ok=True)
            journal["appliedCount"] = index + 1
            journal["updatedAt"] = _now()
            atomic_write_json(journal_path, journal)
        journal["phase"] = "committed"
        journal["updatedAt"] = _now()
        atomic_write_json(journal_path, journal)
        if not all(_target_matches(cache_dir, entry, "after") for entry in entries):
            raise ProtocolError("事务提交后的目标指纹校验失败")
        _cleanup_transaction(cache_dir, journal)
    except Exception:
        try:
            _restore_before(cache_dir, journal)
            _cleanup_transaction(cache_dir, journal)
        except Exception:
            pass
        raise
