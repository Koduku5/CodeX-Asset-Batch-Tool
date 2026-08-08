#!/usr/bin/env python3
"""Run the current asset queue through the IntinifyCanvas image API."""

from __future__ import annotations

import json
import os
import socket
import sys
import time
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
    clean_text,
)
from api_batch.remote_client import (  # noqa: E402
    APIError,
    AuthSession,
    NetworkError,
    SubmissionGate,
    configure_remote_api,
    upload_image,
)
from api_batch.file_runtime import (  # noqa: E402
    configure_file_runtime,
    install_candidate_file_snapshot,
    install_downloaded_file_without_overwrite,
    read_json,
    resolve_output,
    write_json_atomic,
)
from api_batch.queue_runtime import (  # noqa: E402
    api_execution_fingerprint,
    configure_queue_runtime,
    load_queue,
    queue_freshness_errors,
    queue_operation,
    resolve_reference_file,
)
from api_batch.item_runner import (  # noqa: E402
    configure_item_runner,
    current_state_for_item,
    remote_images_for_redownload,
    remote_output_needs_reconciliation,
)
from api_batch.batch_execution import (  # noqa: E402
    canvas_records,
    configure_batch_execution,
    execute_jobs,
)
from api_batch.batch_lock import (  # noqa: E402
    BatchLock,
    acquire_batch_lock,
    configure_batch_lock,
    release_batch_lock,
    retain_batch_lock,
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
configure_item_runner(
    directory_redraw_mode=DIRECTORY_REDRAW_MODE,
    only_key=ONLY_KEY,
    max_image_attempts=MAX_IMAGE_ATTEMPTS,
    base_url=BASE_URL,
    project_id=PROJECT_ID,
    model_id=MODEL_ID,
    default_aspect_ratio=DEFAULT_ASPECT_RATIO,
    default_image_size=DEFAULT_IMAGE_SIZE,
)
configure_batch_lock(
    cache_dir=CACHE_DIR,
    guard_path=GUARD_PATH,
    lock_path=LOCK_PATH,
    directory_redraw_mode=DIRECTORY_REDRAW_MODE,
    only_key=ONLY_KEY,
    resume=RESUME,
    process_start_time=PROCESS_START_TIME,
    process_host=PROCESS_HOST,
    base_url=BASE_URL,
    project_id=PROJECT_ID,
    model_id=MODEL_ID,
    default_aspect_ratio=DEFAULT_ASPECT_RATIO,
    default_image_size=DEFAULT_IMAGE_SIZE,
)
configure_batch_execution(
    max_workers=MAX_WORKERS,
    base_url=BASE_URL,
    project_id=PROJECT_ID,
    model_id=MODEL_ID,
    default_aspect_ratio=DEFAULT_ASPECT_RATIO,
    default_image_size=DEFAULT_IMAGE_SIZE,
)


def proxy_handler() -> ProxyHandler:
    return ProxyHandler({}) if DIRECT_API_CONNECTION else ProxyHandler()




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
