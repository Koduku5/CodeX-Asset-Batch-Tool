#!/usr/bin/env python3
"""Run the current asset queue through the IntinifyCanvas image API."""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from urllib.request import ProxyHandler, build_opener


LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
sys.dont_write_bytecode = True
sys.path.insert(0, str(LIB_DIR))

from api_security import (  # noqa: E402
    SameOriginRedirectHandler,
    normalize_base_url,
    require_secure_transport,
    resolves_only_to_private_addresses,
)
from api_batch.image_validation import valid_png  # noqa: E402
from api_batch.canvas_layout import save_canvas_nodes  # noqa: E402
from api_batch.progress_store import (  # noqa: E402
    ProgressStore,
    attempt_entry_for,
    clean_text,
    normalize_attempt_ledger,
)
from api_batch.remote_client import (  # noqa: E402
    APIError,
    AuthSession,
    NetworkError,
    OutputConflictError,
    SubmissionGate,
    SubmissionNotFound,
    SubmissionsStopped,
    configure_remote_api,
    download_first_valid_image,
    failure_details,
    submit_task,
    upload_image,
    wait_for_result,
)
from api_batch.file_runtime import (  # noqa: E402
    configure_file_runtime,
    file_snapshot,
    install_candidate_file_snapshot,
    install_downloaded_file_without_overwrite,
    normalize_install_candidate_snapshot,
    read_json,
    require_new_output_target,
    require_unchanged_missing_output_baseline,
    resolve_output,
    write_json_atomic,
)
from api_batch.queue_runtime import (  # noqa: E402
    api_execution_fingerprint,
    configure_queue_runtime,
    load_queue,
    queue_execution_fingerprint,
    queue_freshness_errors,
    queue_operation,
    resolve_reference_file,
)


PROCESS_START_TIME = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
PROCESS_HOST = socket.gethostname()
QUEUE_VERSION = 4
PROGRESS_VERSION = 3
IMAGE_SHEET_ORDER = ("角色", "生物", "群演", "场景", "道具")
MAX_IMAGE_ATTEMPTS = 2
RETRYABLE_CODES = {
    "image.upload_timeout",
    "image.timeout",
    "image.rate_limited",
    "image.provider_error",
    "image.network_error",
    "image.no_result",
    "task.user_limit",
    "task.interrupted_restart",
}
TERMINAL_CODES = {
    "validation.inline_image_not_allowed",
    "image.prohibited_content",
    "image.upload_too_large",
    "project_group_image_generation_disabled",
}




def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def required_password_env(name: str) -> str:
    """Read a password verbatim; surrounding whitespace may be intentional."""
    value = os.environ.get(name)
    if value is None or value == "":
        raise SystemExit(f"{name} is required")
    return value


def parse_args() -> tuple[Path, bool, str, bool]:
    args = sys.argv[1:]
    resume = False
    if "--resume" in args:
        args.remove("--resume")
        resume = True
    only_key = ""
    if "--only-key" in args:
        index = args.index("--only-key")
        if index + 1 >= len(args):
            raise SystemExit("--only-key requires a queue key")
        only_key = args[index + 1].strip()
        del args[index : index + 2]
        if not only_key:
            raise SystemExit("--only-key requires a non-empty queue key")
    if "--only-key" in args:
        raise SystemExit("--only-key may only be specified once")
    directory_redraw = False
    if "--directory-redraw" in args:
        args.remove("--directory-redraw")
        directory_redraw = True
    if "--directory-redraw" in args:
        raise SystemExit("--directory-redraw may only be specified once")
    if len(args) != 1:
        raise SystemExit(
            "usage: batch_generate_images.py <skill-root> [--resume] [--only-key <queue-key>] [--directory-redraw]"
        )
    return Path(args[0]).resolve(), resume, only_key, directory_redraw


SKILL_ROOT, RESUME, ONLY_KEY, DIRECTORY_REDRAW_MODE = parse_args()
CACHE_DIR = SKILL_ROOT / "cache"
DIRECTORY_REDRAW_CACHE_DIR = CACHE_DIR / "批量重绘"
QUEUE_PATH = (
    DIRECTORY_REDRAW_CACHE_DIR / "队列.json"
    if DIRECTORY_REDRAW_MODE
    else CACHE_DIR / "出图队列.json"
)
PROGRESS_PATH = (
    DIRECTORY_REDRAW_CACHE_DIR / "进度.json"
    if DIRECTORY_REDRAW_MODE
    else CACHE_DIR / "出图进度.json"
)
LOCK_PATH = CACHE_DIR / ".pipeline.lock"
GUARD_PATH = CACHE_DIR / ".pipeline.api.guard"
IMAGE_OUTPUT_ROOT_PATH = SKILL_ROOT / "输出" / "资产图"
IMAGE_OUTPUT_ROOT = IMAGE_OUTPUT_ROOT_PATH.resolve()

configure_file_runtime(
    skill_root=SKILL_ROOT,
    image_output_root=IMAGE_OUTPUT_ROOT,
    directory_redraw_mode=DIRECTORY_REDRAW_MODE,
)

def validated_base_url(value: str) -> str:
    try:
        return normalize_base_url(value)
    except ValueError as error:
        raise SystemExit(f"KA_API_BASE_URL is invalid: {error}") from error


BASE_URL = validated_base_url(required_env("KA_API_BASE_URL"))
API_URL = BASE_URL + "/api/v1"
USERNAME = required_env("KA_API_USERNAME")
PASSWORD = required_password_env("KA_API_PASSWORD")
PROJECT_ID = required_env("KA_API_PROJECT_ID")
MODEL_ID = required_env("KA_API_MODEL_ID")
try:
    MAX_WORKERS = int(os.environ.get("KA_API_MAX_WORKERS", "2"))
except ValueError as error:
    raise SystemExit("KA_API_MAX_WORKERS must be an integer from 1 to 16") from error
DEFAULT_ASPECT_RATIO = os.environ.get("KA_API_ASPECT_RATIO", "1:1").strip() or "1:1"
DEFAULT_IMAGE_SIZE = os.environ.get("KA_API_IMAGE_SIZE", "1K").strip() or "1K"

if not 1 <= MAX_WORKERS <= 16:
    raise SystemExit("KA_API_MAX_WORKERS must be an integer from 1 to 16")


try:
    require_secure_transport(BASE_URL)
except ValueError as error:
    raise SystemExit(f"KA_API_BASE_URL is unsafe: {error}") from error
DIRECT_API_CONNECTION = resolves_only_to_private_addresses(BASE_URL)

configure_queue_runtime(
    image_sheet_order=IMAGE_SHEET_ORDER,
    queue_version=QUEUE_VERSION,
    directory_redraw_mode=DIRECTORY_REDRAW_MODE,
    only_key=ONLY_KEY,
    queue_path=QUEUE_PATH,
    progress_path=PROGRESS_PATH,
    skill_root=SKILL_ROOT,
    cache_dir=CACHE_DIR,
    image_output_root=IMAGE_OUTPUT_ROOT,
    image_output_root_path=IMAGE_OUTPUT_ROOT_PATH,
    base_url=BASE_URL,
    project_id=PROJECT_ID,
    model_id=MODEL_ID,
    default_aspect_ratio=DEFAULT_ASPECT_RATIO,
    default_image_size=DEFAULT_IMAGE_SIZE,
)


def proxy_handler() -> ProxyHandler:
    return ProxyHandler({}) if DIRECT_API_CONNECTION else ProxyHandler()




class BatchLock:
    def __init__(self, payload: dict, handle):
        self.payload = payload
        self.handle = handle

    def get(self, key: str, default=None):
        return self.payload.get(key, default)









API_OPENER = build_opener(proxy_handler(), SameOriginRedirectHandler(BASE_URL))
IMAGE_OPENER = build_opener(proxy_handler(), SameOriginRedirectHandler(BASE_URL))
configure_remote_api(
    api_opener=API_OPENER,
    image_opener=IMAGE_OPENER,
    api_url=API_URL,
    base_url=BASE_URL,
    username=USERNAME,
    password=PASSWORD,
    project_id=PROJECT_ID,
    model_id=MODEL_ID,
    default_aspect_ratio=DEFAULT_ASPECT_RATIO,
    default_image_size=DEFAULT_IMAGE_SIZE,
    max_image_attempts=MAX_IMAGE_ATTEMPTS,
    retryable_codes=RETRYABLE_CODES,
    terminal_codes=TERMINAL_CODES,
    resolve_reference_file=resolve_reference_file,
    install_candidate_file_snapshot=install_candidate_file_snapshot,
    install_downloaded_file_without_overwrite=install_downloaded_file_without_overwrite,
)



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


def progress_has_remote_tasks(store) -> bool:
    if store is None:
        return False
    items = store.snapshot().get("items", {})
    return any(
        isinstance(state, dict)
        and state.get("backend") == "api"
        and state.get("status") == "generating"
        for state in items.values()
    )




def current_state_for_item(store: ProgressStore, item: dict) -> dict:
    state = store.get(item["key"])
    if DIRECTORY_REDRAW_MODE:
        if state.get("inputFingerprint") != item["inputFingerprint"]:
            return {}
        if state.get("backend") == "builtin" and state.get("status") == "failed":
            return {}
        return state

    ledger = normalize_attempt_ledger(state)
    api_attempt = attempt_entry_for(ledger, "api", item["inputFingerprint"])
    ledger["api"] = api_attempt

    def api_pending_state() -> dict:
        return {
            "attempts": api_attempt["attempts"],
            "attemptLedger": ledger,
        }

    if state.get("inputFingerprint") != item["inputFingerprint"]:
        return api_pending_state()
    if state.get("backend") == "builtin" and state.get("status") == "failed":
        return api_pending_state()
    if (
        ONLY_KEY
        and item["key"] == ONLY_KEY
        and state.get("backend") == "builtin"
        and state.get("status") == "completed"
    ):
        return api_pending_state()
    result = dict(state)
    result["attemptLedger"] = ledger
    if result.get("backend") != "builtin" or result.get("status") != "generating":
        result["attempts"] = api_attempt["attempts"]
    return result


def remote_images_for_redownload(state: dict, output_path: Path) -> list[str]:
    images = state.get("remoteImages", [])
    if not isinstance(images, list):
        return []
    images = [url for url in images if isinstance(url, str) and clean_text(url)]
    if state.get("backend") != "api" or not images:
        return []
    if valid_png(output_path):
        baseline = state.get("outputBaseline")
        if not isinstance(baseline, dict) or file_snapshot(output_path) != baseline:
            return []
    status = clean_text(state.get("status"))
    remote_status = clean_text(state.get("remoteStatus"))
    eligible = (
        status == "completed"
        or (
            status == "generating"
            and remote_status
            in {"completed", "download_installing", "download_interrupted", "download_retry"}
        )
        or (
            status == "failed"
            and remote_status == "completed"
            and int(state.get("downloadAttempts") or 0) < 2
        )
    )
    return images if eligible else []


def remote_output_needs_reconciliation(state: dict, output_path: Path) -> bool:
    images = state.get("remoteImages", [])
    baseline = state.get("outputBaseline")
    candidate_url = state.get("downloadCandidate")
    expected_snapshot = normalize_install_candidate_snapshot(
        state.get("installCandidateSnapshot")
    )
    if not (
        state.get("backend") == "api"
        and state.get("status") != "completed"
        and clean_text(state.get("remoteStatus")) in {"completed", "download_installing"}
        and isinstance(images, list)
        and isinstance(candidate_url, str)
        and clean_text(candidate_url)
        and candidate_url in images
        and baseline == {"exists": False}
        and expected_snapshot is not None
        and valid_png(output_path)
    ):
        return False
    try:
        return install_candidate_file_snapshot(output_path) == expected_snapshot
    except (FileNotFoundError, IsADirectoryError, OSError):
        return False


def run_item(
    index: int,
    auth: AuthSession,
    item: dict,
    uploaded_urls: dict,
    store: ProgressStore,
    submission_gate: SubmissionGate | None = None,
):
    key = item["key"]
    output_path = resolve_output(item["outputPath"])
    state = current_state_for_item(store, item)
    original_attempts = int(state.get("attempts") or 0)
    existing_task_id = clean_text(state.get("taskId") or state.get("requestId"))
    task_id = existing_task_id
    phase = "poll" if state.get("status") == "generating" else "submit"

    def now() -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def stop_new_submissions() -> None:
        if submission_gate is not None:
            submission_gate.stop()

    def preserve_in_flight(error: Exception, remote_status: str):
        stop_new_submissions()
        state.update(
            {
                "status": "generating",
                "backend": "api",
                "remoteStatus": remote_status,
                "error": clean_text(error)[:2000] or error.__class__.__name__,
                "updatedAt": now(),
                "inputFingerprint": item["inputFingerprint"],
                "outputPath": item["outputPath"],
                "retryable": True,
                "terminal": False,
            }
        )
        if task_id:
            state["taskId"] = task_id
        if isinstance(error, APIError):
            if error.code:
                state["failureCode"] = error.code
            if error.category:
                state["failureCategory"] = error.category
        store.set(key, dict(state))
        return {
            "index": index,
            "key": key,
            "status": "generating",
            "task_id": task_id,
            "error": state["error"],
            "stop_submissions": True,
        }

    def fail_state(
        error: Exception,
        remote_status: str = "failed",
        *,
        retryable_override: bool | None = None,
        stop_submissions: bool = False,
    ):
        attempts = int(state.get("attempts") or 0)
        details = failure_details(error, attempts)
        if retryable_override is not None:
            details["retryable"] = retryable_override
            details["terminal"] = (not retryable_override) or attempts >= MAX_IMAGE_ATTEMPTS
        if stop_submissions:
            stop_new_submissions()
        state.update(
            {
                "status": "failed",
                "backend": "api",
                "remoteStatus": remote_status,
                "error": clean_text(error)[:2000] or error.__class__.__name__,
                "updatedAt": now(),
                "inputFingerprint": item["inputFingerprint"],
                "outputPath": item["outputPath"],
                **details,
            }
        )
        store.set(key, dict(state))
        result = {
            "index": index,
            "key": key,
            "status": "failed",
            "error": state["error"],
            "retryable": state["retryable"],
        }
        if stop_submissions:
            result["stop_submissions"] = True
        return result

    if remote_output_needs_reconciliation(state, output_path):
        remote_images = [
            url
            for url in state.get("remoteImages", [])
            if isinstance(url, str) and clean_text(url)
        ]
        selected_url = clean_text(
            state.get("downloadCandidate") or state.get("downloadedImage")
        )
        if selected_url not in remote_images:
            selected_url = remote_images[0]
        state.update(
            {
                "status": "completed",
                "remoteStatus": "completed",
                "downloadedImage": selected_url,
                "outputPath": item["outputPath"],
                "error": "",
                "updatedAt": now(),
                "retryable": False,
                "terminal": False,
            }
        )
        state.pop("downloadCandidate", None)
        state.pop("installCandidateSnapshot", None)
        store.set(key, dict(state))
        return {
            "index": index,
            "key": key,
            "status": "completed",
            "task_id": task_id,
            "reconciled": True,
        }

    if state.get("status") == "completed" and valid_png(output_path):
        return {"index": index, "key": key, "status": "completed", "skipped": True}
    if state.get("status") == "generating" and state.get("backend") not in {None, "api"}:
        raise RuntimeError(f"任务 {key} 正由内置出图路径处理")

    def on_download_attempt(image_url: str) -> None:
        state.update(
            {
                "status": "generating",
                "remoteStatus": "download_installing",
                "downloadCandidate": image_url,
                "updatedAt": now(),
            }
        )
        state.pop("installCandidateSnapshot", None)
        store.set(key, dict(state))

    def on_install_candidate(image_url: str, candidate_snapshot: dict) -> None:
        normalized_snapshot = normalize_install_candidate_snapshot(candidate_snapshot)
        remote_images = state.get("remoteImages")
        if (
            normalized_snapshot is None
            or not isinstance(remote_images, list)
            or image_url not in remote_images
            or state.get("downloadCandidate") != image_url
        ):
            raise RuntimeError("download candidate state changed before installation")
        state.update(
            {
                "status": "generating",
                "remoteStatus": "download_installing",
                "downloadCandidate": image_url,
                "installCandidateSnapshot": normalized_snapshot,
                "updatedAt": now(),
            }
        )
        store.set(key, dict(state))

    saved_images = remote_images_for_redownload(state, output_path)
    remote_status = clean_text(state.get("remoteStatus"))
    if saved_images:
        phase = "download"
        state["downloadAttempts"] = int(state.get("downloadAttempts") or 0) + 1
        output_baseline = state.get("outputBaseline")

        try:
            require_unchanged_missing_output_baseline(output_path, output_baseline)
            selected_url = download_first_valid_image(
                saved_images,
                output_path,
                output_baseline,
                on_attempt=on_download_attempt,
                on_install_candidate=on_install_candidate,
            )
            state.update(
                {
                    "status": "completed",
                    "remoteStatus": "completed",
                    "remoteImages": saved_images,
                    "downloadedImage": selected_url,
                    "outputPath": item["outputPath"],
                    "error": "",
                    "updatedAt": now(),
                    "retryable": False,
                    "terminal": False,
                }
            )
            state.pop("downloadCandidate", None)
            state.pop("installCandidateSnapshot", None)
            store.set(key, dict(state))
            return {
                "index": index,
                "key": key,
                "status": "completed",
                "task_id": task_id,
                "redownloaded": True,
            }
        except OutputConflictError as error:
            return preserve_in_flight(error, "completed")
        except NetworkError as error:
            return preserve_in_flight(error, "download_interrupted")
        except APIError as error:
            return fail_state(error, "completed", retryable_override=True)
        except Exception as error:
            return fail_state(error, "completed")

    if state.get("terminal") is True or original_attempts >= MAX_IMAGE_ATTEMPTS:
        return {"index": index, "key": key, "status": "failed", "skipped": True}

    resuming = state.get("status") == "generating" and bool(existing_task_id)
    if state.get("status") == "generating" and not existing_task_id:
        return preserve_in_flight(
            RuntimeError("远端任务处于进行中但缺少 taskId/requestId"),
            remote_status or "submission_unknown",
        )
    if not resuming:
        try:
            require_new_output_target(output_path)
        except OutputConflictError as error:
            return fail_state(
                error,
                "output_conflict",
                retryable_override=True,
                stop_submissions=True,
            )

    reference_paths = item.get("references", [])
    saved_reference_urls = state.get("referenceUrls", [])
    if resuming:
        reference_urls = (
            [clean_text(url) for url in saved_reference_urls if clean_text(url)]
            if isinstance(saved_reference_urls, list)
            else []
        )
    else:
        reference_urls = [uploaded_urls[path] for path in reference_paths]

    if resuming:
        request_id = clean_text(state.get("requestId")) or task_id
        state.setdefault("projectId", PROJECT_ID)
        state.setdefault("modelId", MODEL_ID)
        state.setdefault("baseUrl", BASE_URL)
        state.setdefault("aspectRatio", clean_text(item.get("aspectRatio")) or DEFAULT_ASPECT_RATIO)
        state.setdefault("imageSize", clean_text(item.get("imageSize")) or DEFAULT_IMAGE_SIZE)
        state.setdefault("executionFingerprint", api_execution_fingerprint())
        state.setdefault("operationMode", clean_text(item.get("operation")) or "generate")
        state.setdefault("startedAt", state.get("updatedAt") or now())
        state.setdefault("referenceUrls", reference_urls)
        state.setdefault(
            "submissionAcknowledged",
            remote_status
            not in {"submitting", "submission_unknown", "submission_visibility_check"},
        )
        store.set(key, dict(state))
    else:
        request_id = "asset-" + uuid.uuid4().hex
        task_id = request_id

    def initialize_and_submit() -> str:
        nonlocal state
        attempts = original_attempts + 1
        output_baseline = require_new_output_target(output_path)
        state = {
            "status": "generating",
            "backend": "api",
            "attempts": attempts,
            "outputPath": item["outputPath"],
            "error": "",
            "updatedAt": now(),
            "startedAt": now(),
            "inputFingerprint": item["inputFingerprint"],
            "outputBaseline": output_baseline,
            "requestId": request_id,
            "taskId": request_id,
            "remoteStatus": "submitting",
            "submissionAcknowledged": False,
            "referenceUrls": reference_urls,
            "projectId": PROJECT_ID,
            "modelId": MODEL_ID,
            "baseUrl": BASE_URL,
            "executionFingerprint": api_execution_fingerprint(),
            "operationMode": clean_text(item.get("operation")) or "generate",
            "aspectRatio": clean_text(item.get("aspectRatio")) or DEFAULT_ASPECT_RATIO,
            "imageSize": clean_text(item.get("imageSize")) or DEFAULT_IMAGE_SIZE,
        }
        store.set(key, dict(state))
        return submit_task(auth, item, reference_urls, request_id)

    try:
        if not resuming:
            if submission_gate is None:
                returned_task_id = initialize_and_submit()
            else:
                returned_task_id = submission_gate.submit(initialize_and_submit)
            task_id = returned_task_id
            phase = "poll"
            state.update(
                {
                    "taskId": task_id,
                    "remoteStatus": "queued",
                    "submissionAcknowledged": True,
                    "updatedAt": now(),
                }
            )
            store.set(key, dict(state))

        def on_status(next_remote_status, queue_position):
            state["remoteStatus"] = next_remote_status
            if next_remote_status != "submission_visibility_check":
                state["submissionAcknowledged"] = True
            if isinstance(queue_position, int):
                state["queuePosition"] = queue_position
            else:
                state.pop("queuePosition", None)
            state["updatedAt"] = now()
            store.set(key, dict(state))

        unknown_submission = resuming and state.get("submissionAcknowledged") is not True
        result = wait_for_result(
            auth,
            task_id,
            on_status,
            allow_initial_not_found=(not resuming) or unknown_submission,
            not_found_means_not_created=unknown_submission,
        )
        phase = "download"
        image_urls = result.get("images", []) if isinstance(result, dict) else []
        if not isinstance(image_urls, list) or not image_urls or not all(
            isinstance(url, str) and clean_text(url) for url in image_urls
        ):
            raise APIError(
                500,
                {
                    "status": "failed",
                    "error_code": "image.no_result",
                    "failure_code": "image.no_result",
                    "message": f"task {task_id} completed without images",
                },
            )
        state.update(
            {
                "remoteStatus": "completed",
                "remoteImages": image_urls,
                "downloadAttempts": int(state.get("downloadAttempts") or 0) + 1,
                "updatedAt": now(),
            }
        )
        store.set(key, dict(state))

        output_baseline = state.get("outputBaseline")
        require_unchanged_missing_output_baseline(output_path, output_baseline)
        selected_url = download_first_valid_image(
            image_urls,
            output_path,
            output_baseline,
            on_attempt=on_download_attempt,
            on_install_candidate=on_install_candidate,
        )
        state.update(
            {
                "status": "completed",
                "remoteStatus": "completed",
                "downloadedImage": selected_url,
                "outputPath": item["outputPath"],
                "error": "",
                "updatedAt": now(),
                "retryable": False,
                "terminal": False,
            }
        )
        state.pop("downloadCandidate", None)
        state.pop("installCandidateSnapshot", None)
        store.set(key, dict(state))
        return {"index": index, "key": key, "status": "completed", "task_id": task_id}
    except OutputConflictError as error:
        if phase == "submit":
            state["attempts"] = original_attempts
            return fail_state(
                error,
                "output_conflict",
                retryable_override=True,
                stop_submissions=True,
            )
        return preserve_in_flight(error, "completed")
    except SubmissionsStopped as error:
        return {
            "index": index,
            "key": key,
            "status": state.get("status") or "pending",
            "error": clean_text(error),
            "stop_submissions": True,
            "deferred": True,
        }
    except SubmissionNotFound as error:
        missing = APIError(
            404,
            {
                "status": "not_created",
                "failure_code": "task.not_found_after_submit",
                "failure_category": "submission",
                "message": clean_text(error),
            },
        )
        return fail_state(missing, "not_created", retryable_override=True)
    except (NetworkError, TimeoutError) as error:
        remote = {
            "submit": "submission_unknown",
            "poll": "query_interrupted",
            "download": "download_interrupted",
        }.get(phase, "connection_interrupted")
        return preserve_in_flight(error, remote)
    except APIError as error:
        explicit_task_failure = clean_text(error.payload.get("status")) in {
            "failed",
            "cancelled",
            "expired",
        }
        if phase == "poll" and not explicit_task_failure:
            return preserve_in_flight(error, "query_interrupted")
        if phase == "submit" and error.status in {408, 425, 500, 502, 503, 504}:
            return preserve_in_flight(error, "submission_unknown")
        if phase == "submit" and (error.status == 429 or error.code == "task.user_limit"):
            state["attempts"] = original_attempts
            return fail_state(error, "not_created", retryable_override=True, stop_submissions=True)
        if phase == "submit" and error.status == 401:
            return fail_state(error, "not_created", retryable_override=True, stop_submissions=True)
        if phase == "submit" and (
            error.status == 403 or error.code == "project_group_image_generation_disabled"
        ):
            state["attempts"] = original_attempts
            return fail_state(error, "not_created", stop_submissions=True)
        if phase == "download" and error.code == "image.no_result":
            return fail_state(error, "completed", retryable_override=True)
        return fail_state(
            error,
            clean_text(error.payload.get("status")) or "failed",
        )
    except Exception as error:
        if phase in {"submit", "poll"}:
            return preserve_in_flight(
                error,
                "submission_unknown" if phase == "submit" else "query_interrupted",
            )
        return fail_state(error, "completed" if phase == "download" else "failed")


def canvas_records(
    queue: dict, progress: dict, allowed_keys: set[str] | None = None
) -> list[dict]:
    records = []
    states = progress.get("items", {})
    for index, item in enumerate(queue["items"], start=1):
        if allowed_keys is not None and item["key"] not in allowed_keys:
            continue
        state = states.get(item["key"])
        if not isinstance(state, dict):
            continue
        if (
            state.get("status") != "completed"
            or state.get("backend") != "api"
            or clean_text(state.get("projectId")) != PROJECT_ID
            or clean_text(state.get("baseUrl")) not in {"", BASE_URL}
            or state.get("inputFingerprint") != item["inputFingerprint"]
            or not valid_png(resolve_output(item["outputPath"]))
        ):
            continue
        downloaded_image = clean_text(state.get("downloadedImage"))
        legacy_images = state.get("remoteImages", [])
        if downloaded_image:
            images = [downloaded_image]
        elif isinstance(legacy_images, list):
            # Legacy runs only downloaded the first result URL; do not publish unverified siblings.
            images = [url for url in legacy_images if isinstance(url, str) and clean_text(url)][:1]
        else:
            images = []
        if not images:
            continue
        records.append(
            {
                "index": index,
                "prompt": item["prompt"],
                "references": state.get("referenceUrls", []),
                "images": images,
                "aspect_ratio": clean_text(state.get("aspectRatio")) or DEFAULT_ASPECT_RATIO,
                "image_size": clean_text(state.get("imageSize")) or DEFAULT_IMAGE_SIZE,
                "model_id": clean_text(state.get("modelId")) or MODEL_ID,
            }
        )
    return records


def execute_jobs(
    jobs: list[tuple[int, dict]],
    auth: AuthSession,
    uploaded_urls: dict,
    store: ProgressStore,
    submission_gate: SubmissionGate,
) -> tuple[list[dict], bool, int]:
    """Keep only active workers queued so a stop result prevents later admissions."""
    results = []
    next_job = 0
    stopped = submission_gate.stopped()
    pending = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        def fill_workers() -> None:
            nonlocal next_job
            while not stopped and next_job < len(jobs) and len(pending) < MAX_WORKERS:
                index, item = jobs[next_job]
                next_job += 1
                future = executor.submit(
                    run_item,
                    index,
                    auth,
                    item,
                    uploaded_urls,
                    store,
                    submission_gate,
                )
                pending[future] = item["key"]

        fill_workers()
        while pending:
            done, _ = wait(tuple(pending), return_when=FIRST_COMPLETED)
            for future in done:
                key = pending.pop(future)
                try:
                    result = future.result()
                except Exception as error:
                    submission_gate.stop()
                    result = {
                        "key": key,
                        "status": "failed",
                        "error": clean_text(error) or error.__class__.__name__,
                        "stop_submissions": True,
                    }
                results.append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
                if result.get("stop_submissions"):
                    stopped = True
            if submission_gate.stopped():
                stopped = True
            if not stopped:
                fill_workers()
    return results, stopped, len(jobs) - next_job


def main() -> None:
    queue = load_queue()
    lock = acquire_batch_lock(queue)
    store = None
    exit_code = 0
    try:
        store = ProgressStore(
            queue,
            progress_path=PROGRESS_PATH,
            progress_version=PROGRESS_VERSION,
            directory_redraw_mode=DIRECTORY_REDRAW_MODE,
            read_json=read_json,
            write_json_atomic=write_json_atomic,
            queue_operation=queue_operation,
            base_url=BASE_URL,
            project_id=PROJECT_ID,
            model_id=MODEL_ID,
            aspect_ratio=DEFAULT_ASPECT_RATIO,
            image_size=DEFAULT_IMAGE_SIZE,
            api_execution_fingerprint=api_execution_fingerprint,
        )
        store.set_batch_configuration(queue)
        freshness_errors = queue_freshness_errors(queue)
        if freshness_errors:
            exit_code = 1
        current_execution = api_execution_fingerprint()
        active_api_keys = set()
        resume_runnable = []
        new_runnable = []
        selected_item_found = not ONLY_KEY
        for index, item in enumerate(queue["items"], start=1):
            selected = not ONLY_KEY or item["key"] == ONLY_KEY
            if selected:
                selected_item_found = True
            state = current_state_for_item(store, item)
            output_path = resolve_output(item["outputPath"])
            saved_execution = clean_text(state.get("executionFingerprint"))
            if state.get("backend") == "api" and saved_execution and saved_execution != current_execution:
                raise SystemExit(
                    f"当前 API 配置与已有任务不一致：{item['key']}；禁止在同一队列混用服务、项目、模型、比例或尺寸"
                )
            if state.get("status") == "generating" and state.get("backend") == "builtin":
                raise SystemExit(
                    f"内置出图任务仍未进入终态：{item['key']}；禁止切换到 API 批量任务"
                )
            if state.get("status") == "generating" and state.get("backend") == "api":
                if not selected:
                    raise SystemExit(
                        f"其他 API 任务仍在运行：{item['key']}；单项执行不能忽略远端任务"
                    )
                active_api_keys.add(item["key"])
                if clean_text(state.get("projectId")) not in {"", PROJECT_ID}:
                    raise SystemExit(f"API 项目已变化，禁止恢复远端任务：{item['key']}")
                if clean_text(state.get("modelId")) not in {"", MODEL_ID}:
                    raise SystemExit(f"API 模型已变化，禁止恢复远端任务：{item['key']}")
                if clean_text(state.get("baseUrl")) not in {"", BASE_URL}:
                    raise SystemExit(f"API 服务地址已变化，禁止恢复远端任务：{item['key']}")
            if not selected:
                continue
            if freshness_errors and item["key"] not in active_api_keys:
                exit_code = 1
                continue
            if state.get("status") == "completed" and valid_png(output_path):
                continue
            remote_recovery = bool(remote_images_for_redownload(state, output_path))
            remote_reconciliation = remote_output_needs_reconciliation(state, output_path)
            if remote_recovery or remote_reconciliation or (
                state.get("status") == "generating" and state.get("backend") == "api"
            ):
                resume_runnable.append((index, item))
                continue
            if state.get("terminal") is True or int(state.get("attempts") or 0) >= MAX_IMAGE_ATTEMPTS:
                exit_code = 1
                continue
            new_runnable.append((index, item))

        if not selected_item_found:
            raise SystemExit(f"出图队列中不存在指定任务：{ONLY_KEY}")

        if freshness_errors and not active_api_keys:
            raise SystemExit(
                "出图队列已失效，请重新建立后再调用 API：" + "；".join(freshness_errors)
            )

        canvas_skipped = bool(ONLY_KEY) or DIRECTORY_REDRAW_MODE
        auth = (
            AuthSession()
            if resume_runnable or new_runnable or not canvas_skipped
            else None
        )
        submission_gate = SubmissionGate(lambda: queue_freshness_errors(queue))
        if resume_runnable:
            resume_results, stopped, resume_deferred = execute_jobs(
                resume_runnable,
                auth,
                {},
                store,
                submission_gate,
            )
        else:
            resume_results, stopped, resume_deferred = [], False, 0
        if resume_deferred:
            exit_code = 1
        if any(result.get("status") != "completed" for result in resume_results):
            exit_code = 1

        new_deferred = 0
        if not stopped and new_runnable:
            runnable_items = [item for _, item in new_runnable]
            reference_paths = list(
                dict.fromkeys(path for item in runnable_items for path in item.get("references", []))
            )
            uploaded_urls = {}
            for item in runnable_items:
                saved = current_state_for_item(store, item)
                saved_urls = saved.get("referenceUrls", [])
                local_paths = item.get("references", [])
                if isinstance(saved_urls, list) and len(saved_urls) == len(local_paths):
                    for local_path, remote_url in zip(local_paths, saved_urls):
                        if clean_text(remote_url):
                            uploaded_urls.setdefault(local_path, remote_url)
            for reference_path in reference_paths:
                if reference_path not in uploaded_urls:
                    uploaded_urls[reference_path] = upload_image(auth, reference_path)

            new_results, stopped, new_deferred = execute_jobs(
                new_runnable,
                auth,
                uploaded_urls,
                store,
                submission_gate,
            )
            if any(result.get("status") != "completed" for result in new_results):
                exit_code = 1
        elif new_runnable:
            new_deferred = len(new_runnable)
        if new_deferred:
            exit_code = 1
            print(
                json.dumps(
                    {
                        "status": "deferred",
                        "count": new_deferred,
                        "reason": "new submissions stopped after an uncertain or rate-limit response",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

        canvas_error = ""
        saved = {"nodes": 0, "edges": 0}
        if not canvas_skipped:
            store.set_canvas_status("syncing")
            try:
                saved = save_canvas_nodes(
                    auth,
                    PROJECT_ID,
                    canvas_records(queue, store.snapshot()),
                )
                store.set_canvas_status(
                    "completed",
                    nodes=saved["nodes"],
                    edges=saved["edges"],
                )
            except Exception as error:
                canvas_error = clean_text(error)
                store.set_canvas_status("failed", error=canvas_error, nodes=0, edges=0)
                exit_code = 1
        summary = {
            "project_url": f"{BASE_URL}/canvas/{PROJECT_ID}",
            "saved_nodes": saved["nodes"],
            "saved_edges": saved["edges"],
            "canvas_error": canvas_error,
            "canvas_skipped": canvas_skipped,
            "queue_warnings": freshness_errors,
        }
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    finally:
        if progress_has_remote_tasks(store):
            retain_batch_lock(lock)
        else:
            release_batch_lock(lock)
    if exit_code:
        raise SystemExit(exit_code)


if __name__ == "__main__":
    try:
        main()
    except NetworkError:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "code": "api.network_error",
                    "message": "无法连接 API 服务，请检查服务地址、网络和服务状态后重试。",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1)
    except APIError as error:
        message = clean_text(
            error.payload.get("message")
            or error.payload.get("error")
            or error.payload.get("detail")
        ) or f"API 返回 HTTP {error.status}"
        print(
            json.dumps(
                {
                    "status": "failed",
                    "code": error.code or "api.request_failed",
                    "message": message,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1)
