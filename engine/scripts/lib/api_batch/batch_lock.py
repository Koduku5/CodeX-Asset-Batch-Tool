"""Durable cross-process locking for API image-generation batches."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

from api_batch.file_runtime import read_json, write_json_atomic
from api_batch.progress_store import clean_text
from api_batch.queue_runtime import queue_execution_fingerprint, queue_operation


CACHE_DIR = Path(".")
GUARD_PATH = Path(".")
LOCK_PATH = Path(".")
DIRECTORY_REDRAW_MODE = False
ONLY_KEY = ""
RESUME = False
PROCESS_START_TIME = ""
PROCESS_HOST = ""
BASE_URL = ""
PROJECT_ID = ""
MODEL_ID = ""
DEFAULT_ASPECT_RATIO = ""
DEFAULT_IMAGE_SIZE = ""


def configure_batch_lock(
    *,
    cache_dir: Path,
    guard_path: Path,
    lock_path: Path,
    directory_redraw_mode: bool,
    only_key: str,
    resume: bool,
    process_start_time: str,
    process_host: str,
    base_url: str,
    project_id: str,
    model_id: str,
    default_aspect_ratio: str,
    default_image_size: str,
) -> None:
    """Configure process and queue identity used by the lock receipt."""
    global CACHE_DIR, GUARD_PATH, LOCK_PATH, DIRECTORY_REDRAW_MODE, ONLY_KEY, RESUME
    global PROCESS_START_TIME, PROCESS_HOST, BASE_URL, PROJECT_ID, MODEL_ID
    global DEFAULT_ASPECT_RATIO, DEFAULT_IMAGE_SIZE

    CACHE_DIR = cache_dir
    GUARD_PATH = guard_path
    LOCK_PATH = lock_path
    DIRECTORY_REDRAW_MODE = directory_redraw_mode
    ONLY_KEY = only_key
    RESUME = resume
    PROCESS_START_TIME = process_start_time
    PROCESS_HOST = process_host
    BASE_URL = base_url
    PROJECT_ID = project_id
    MODEL_ID = model_id
    DEFAULT_ASPECT_RATIO = default_aspect_ratio
    DEFAULT_IMAGE_SIZE = default_image_size


class BatchLock:
    def __init__(self, payload: dict, handle):
        self.payload = payload
        self.handle = handle

    def get(self, key: str, default=None):
        return self.payload.get(key, default)









def lock_file_handle(handle) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock_file_handle(handle) -> None:
    if handle.closed:
        return
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def acquire_guard_handle():
    descriptor = os.open(GUARD_PATH, os.O_RDWR | os.O_CREAT)
    try:
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"\0")
            os.fsync(descriptor)
        handle = os.fdopen(descriptor, "r+b", buffering=0)
    except Exception:
        os.close(descriptor)
        raise
    try:
        lock_file_handle(handle)
    except OSError as error:
        handle.close()
        raise SystemExit("已有 API 批次或恢复进程持有批次锁，禁止并发运行") from error
    return handle


def create_lock_payload_exclusive(payload: dict) -> None:
    descriptor = os.open(LOCK_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            json.dump(payload, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        LOCK_PATH.unlink(missing_ok=True)
        raise


def acquire_batch_lock(queue: dict) -> BatchLock:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    guard = acquire_guard_handle()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload = {
        "protocolVersion": 2,
        "kind": "image_generation_batch",
        "key": "directory_redraw" if DIRECTORY_REDRAW_MODE else "api_batch",
        "leaseMode": "durable",
        "inputFingerprint": queue_execution_fingerprint(queue),
        "targetKey": ONLY_KEY,
        "processId": os.getpid(),
        "processStartTime": PROCESS_START_TIME,
        "host": PROCESS_HOST,
        "operation": queue_operation(queue),
        "baseUrl": BASE_URL,
        "projectId": PROJECT_ID,
        "modelId": MODEL_ID,
        "aspectRatio": DEFAULT_ASPECT_RATIO,
        "imageSize": DEFAULT_IMAGE_SIZE,
        "token": uuid.uuid4().hex,
        "createdAt": now,
        "updatedAt": now,
    }
    if DIRECTORY_REDRAW_MODE:
        payload["batchId"] = clean_text(queue.get("batchId"))
        payload["queueFingerprint"] = clean_text(queue.get("queueFingerprint"))
    try:
        existing = read_json(LOCK_PATH) if LOCK_PATH.exists() else None
        if existing is not None:
            kind = existing.get("kind", "unknown") if isinstance(existing, dict) else "unknown"
            key = existing.get("key", "unknown") if isinstance(existing, dict) else "unknown"
            resumable = (
                RESUME
                and isinstance(existing, dict)
                and existing.get("kind") == "image_generation_batch"
                and existing.get("inputFingerprint") == queue_execution_fingerprint(queue)
                and clean_text(existing.get("targetKey")) == ONLY_KEY
                and clean_text(existing.get("token"))
            )
            if not resumable:
                raise SystemExit(f"已有流水线任务占用：{kind}:{key}")
            payload["token"] = existing["token"]
            payload["createdAt"] = clean_text(existing.get("createdAt")) or now
            payload["resumedAt"] = now
            payload["updatedAt"] = now
            write_json_atomic(LOCK_PATH, payload)
            return BatchLock(payload, guard)
        try:
            create_lock_payload_exclusive(payload)
        except FileExistsError as error:
            raise SystemExit("已有流水线任务占用，禁止并发启动 API 批次") from error
        return BatchLock(payload, guard)
    except BaseException:
        try:
            unlock_file_handle(guard)
        finally:
            guard.close()
        raise


def release_batch_lock(lock: BatchLock) -> None:
    guard = lock.handle
    try:
        current = read_json(LOCK_PATH, fallback=None)
        if not isinstance(current, dict) or current.get("token") != lock.get("token"):
            raise RuntimeError("流水线锁已被替换，禁止自动删除")
        LOCK_PATH.unlink()
    finally:
        try:
            unlock_file_handle(guard)
        finally:
            guard.close()


def retain_batch_lock(lock: BatchLock) -> None:
    guard = lock.handle
    try:
        current = read_json(LOCK_PATH, fallback=None)
        if not isinstance(current, dict) or current.get("token") != lock.get("token"):
            raise RuntimeError("流水线锁已被替换，禁止更新远端任务锁")
        current["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json_atomic(LOCK_PATH, current)
        lock.payload = current
    finally:
        try:
            unlock_file_handle(guard)
        finally:
            guard.close()

