"""Per-item progress reconciliation and remote generation execution."""

from __future__ import annotations

import time
import uuid
from pathlib import Path

from api_batch.file_runtime import (
    file_snapshot,
    install_candidate_file_snapshot,
    normalize_install_candidate_snapshot,
    require_new_output_target,
    require_unchanged_missing_output_baseline,
    resolve_output,
)
from api_batch.image_validation import valid_png
from api_batch.progress_store import (
    ProgressStore,
    attempt_entry_for,
    clean_text,
    normalize_attempt_ledger,
)
from api_batch.queue_runtime import api_execution_fingerprint
from api_batch.remote_client import (
    APIError,
    AuthSession,
    NetworkError,
    OutputConflictError,
    SubmissionGate,
    SubmissionNotFound,
    SubmissionsStopped,
    download_first_valid_image,
    failure_details,
    submit_task,
    wait_for_result,
)


DIRECTORY_REDRAW_MODE = False
ONLY_KEY = ""
MAX_IMAGE_ATTEMPTS = 0
BASE_URL = ""
PROJECT_ID = ""
MODEL_ID = ""
DEFAULT_ASPECT_RATIO = ""
DEFAULT_IMAGE_SIZE = ""


def configure_item_runner(
    *,
    directory_redraw_mode: bool,
    only_key: str,
    max_image_attempts: int,
    base_url: str,
    project_id: str,
    model_id: str,
    default_aspect_ratio: str,
    default_image_size: str,
) -> None:
    """Configure the immutable execution context used for every queue item."""
    global DIRECTORY_REDRAW_MODE, ONLY_KEY, MAX_IMAGE_ATTEMPTS
    global BASE_URL, PROJECT_ID, MODEL_ID, DEFAULT_ASPECT_RATIO, DEFAULT_IMAGE_SIZE

    DIRECTORY_REDRAW_MODE = directory_redraw_mode
    ONLY_KEY = only_key
    MAX_IMAGE_ATTEMPTS = max_image_attempts
    BASE_URL = base_url
    PROJECT_ID = project_id
    MODEL_ID = model_id
    DEFAULT_ASPECT_RATIO = default_aspect_ratio
    DEFAULT_IMAGE_SIZE = default_image_size



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
