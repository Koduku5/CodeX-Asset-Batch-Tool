"""Authenticated remote image API transport and download operations."""

from __future__ import annotations

import json
import mimetypes
import os
import threading
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request

from api_security import same_origin_url
from bounded_io import (
    InvalidJsonResponseError,
    MAX_API_ERROR_RESPONSE_BYTES,
    MAX_API_JSON_RESPONSE_BYTES,
    MAX_IMAGE_RESPONSE_BYTES,
    ResponseTooLargeError,
    copy_limited_response,
    decode_strict_json_bytes,
    read_limited_bytes,
)
from api_batch.image_validation import read_stable_reference_bytes, valid_png


_API_OPENER = None
_IMAGE_OPENER = None
_API_URL = ""
_BASE_URL = ""
_USERNAME = ""
_PASSWORD = ""
_PROJECT_ID = ""
_MODEL_ID = ""
_DEFAULT_ASPECT_RATIO = "1:1"
_DEFAULT_IMAGE_SIZE = "1K"
_MAX_IMAGE_ATTEMPTS = 2
_RETRYABLE_CODES: set[str] = set()
_TERMINAL_CODES: set[str] = set()
_resolve_reference_file = None
_install_candidate_file_snapshot = None
_install_downloaded_file_without_overwrite = None


def configure_remote_api(*, api_opener, image_opener, api_url: str, base_url: str,
                         username: str, password: str, project_id: str, model_id: str,
                         default_aspect_ratio: str, default_image_size: str,
                         max_image_attempts: int, retryable_codes: set[str],
                         terminal_codes: set[str], resolve_reference_file,
                         install_candidate_file_snapshot,
                         install_downloaded_file_without_overwrite) -> None:
    global _API_OPENER, _IMAGE_OPENER, _API_URL, _BASE_URL, _USERNAME, _PASSWORD
    global _PROJECT_ID, _MODEL_ID, _DEFAULT_ASPECT_RATIO, _DEFAULT_IMAGE_SIZE
    global _MAX_IMAGE_ATTEMPTS, _RETRYABLE_CODES, _TERMINAL_CODES
    global _resolve_reference_file, _install_candidate_file_snapshot
    global _install_downloaded_file_without_overwrite
    _resolve_reference_file = resolve_reference_file
    _install_candidate_file_snapshot = install_candidate_file_snapshot
    _install_downloaded_file_without_overwrite = install_downloaded_file_without_overwrite
    _API_OPENER = api_opener
    _IMAGE_OPENER = image_opener
    _API_URL = api_url
    _BASE_URL = base_url
    _USERNAME = username
    _PASSWORD = password
    _PROJECT_ID = project_id
    _MODEL_ID = model_id
    _DEFAULT_ASPECT_RATIO = default_aspect_ratio
    _DEFAULT_IMAGE_SIZE = default_image_size
    _MAX_IMAGE_ATTEMPTS = max_image_attempts
    _RETRYABLE_CODES = set(retryable_codes)
    _TERMINAL_CODES = set(terminal_codes)


class APIError(RuntimeError):
    def __init__(self, status: int, payload):
        super().__init__(f"HTTP {status}: {payload}")
        self.status = status
        self.payload = payload if isinstance(payload, dict) else {"message": str(payload)}
        self.code = str(
            self.payload.get("error_code")
            or self.payload.get("failure_code")
            or ""
        ).strip()
        self.category = str(self.payload.get("failure_category") or "").strip()


class NetworkError(RuntimeError):
    pass


class OutputConflictError(RuntimeError):
    pass


class SubmissionNotFound(RuntimeError):
    pass


class SubmissionsStopped(RuntimeError):
    pass


class SubmissionGate:
    """Serialize POST admission so a global stop cannot race with another submit."""

    def __init__(self, freshness_check=None):
        self._mutex = threading.Lock()
        self._stopped = threading.Event()
        self._freshness_check = freshness_check

    def stopped(self) -> bool:
        return self._stopped.is_set()

    def stop(self) -> None:
        self._stopped.set()

    def submit(self, callback):
        with self._mutex:
            if self._stopped.is_set():
                raise SubmissionsStopped("new remote submissions are stopped for this run")
            try:
                freshness_errors = (
                    self._freshness_check() if self._freshness_check is not None else []
                )
                if freshness_errors:
                    raise SubmissionsStopped(
                        "image queue changed before submission: "
                        + "; ".join(freshness_errors)
                    )
                return callback()
            except Exception as error:
                if isinstance(error, APIError):
                    global_stop = (
                        error.status in {401, 403, 408, 425, 429, 500, 502, 503, 504}
                        or error.code
                        in {"task.user_limit", "project_group_image_generation_disabled"}
                    )
                else:
                    # Malformed success bodies and all non-HTTP failures are ambiguous.
                    global_stop = True
                if global_stop:
                    self._stopped.set()
                raise

def read_json_response(response):
    raw = read_limited_bytes(
        response,
        MAX_API_JSON_RESPONSE_BYTES,
        "API JSON response",
    )
    return decode_strict_json_bytes(raw, "API JSON response")


def open_json(request: Request, timeout=120):
    try:
        with _API_OPENER.open(request, timeout=timeout) as response:
            return response.status, read_json_response(response)
    except HTTPError as error:
        try:
            raw = read_limited_bytes(
                error,
                MAX_API_ERROR_RESPONSE_BYTES,
                "API error response",
            ).decode("utf-8", errors="strict")
        except ResponseTooLargeError as limit_error:
            raise APIError(
                error.code,
                {
                    "error_code": "api.response_too_large",
                    "message": str(limit_error),
                },
            ) from error
        except UnicodeDecodeError as decode_error:
            raise APIError(
                502,
                {
                    "error_code": "api.invalid_json_response",
                    "message": "API error response is not valid UTF-8",
                },
            ) from decode_error
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"message": raw.strip()}
        raise APIError(error.code, payload) from error
    except ResponseTooLargeError as error:
        raise APIError(
            502,
            {
                "error_code": "api.response_too_large",
                "message": str(error),
            },
        ) from error
    except InvalidJsonResponseError as error:
        raise APIError(
            502,
            {
                "error_code": "api.invalid_json_response",
                "message": str(error),
            },
        ) from error
    except (URLError, TimeoutError, OSError) as error:
        raise NetworkError(str(error)) from error


def json_request(method: str, path: str, token=None, payload=None, timeout=120):
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(_API_URL + path, data=data, headers=headers, method=method)
    return open_json(request, timeout=timeout)


def login() -> str:
    _, payload = json_request(
        "POST",
        "/auth/login",
        payload={"username": _USERNAME, "password": _PASSWORD},
    )
    token = clean_text(payload.get("token")) if isinstance(payload, dict) else ""
    if not token:
        raise RuntimeError("登录响应缺少 token")
    return token


class AuthSession:
    def __init__(self):
        self._mutex = threading.Lock()
        self._token = login()

    def token(self) -> str:
        with self._mutex:
            return self._token

    def refresh(self, stale_token: str) -> str:
        with self._mutex:
            if self._token == stale_token:
                self._token = login()
            return self._token

    def request(self, method: str, path: str, payload=None, timeout=120):
        token = self.token()
        try:
            return json_request(method, path, token, payload, timeout)
        except APIError as error:
            if error.status != 401:
                raise
            token = self.refresh(token)
            return json_request(method, path, token, payload, timeout)


def upload_image(auth: AuthSession, file_name: str) -> str:
    path = _resolve_reference_file(file_name)
    if not path.is_file():
        raise FileNotFoundError(f"参考图不存在：{path}")
    image_bytes = read_stable_reference_bytes(path)
    if image_bytes is None:
        raise ValueError(f"参考图无效、为空或超过 20MB：{path}")
    boundary = "----IntinifyCanvas" + uuid.uuid4().hex
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    safe_name = path.name.replace('"', "")
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="project_id"\r\n\r\n'
        f"{_PROJECT_ID}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    body = prefix + image_bytes + suffix
    token = auth.token()
    for attempt in range(2):
        request = Request(
            _API_URL + "/images/upload",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            _, payload = open_json(request)
            break
        except APIError as error:
            if error.status != 401 or attempt:
                raise
            token = auth.refresh(token)
    image_url = clean_text(payload.get("url")) if isinstance(payload, dict) else ""
    if not image_url:
        raise RuntimeError("参考图上传响应缺少 url")
    return image_url


def submit_task(auth: AuthSession, item: dict, reference_urls: list[str], request_id: str) -> str:
    payload = {
        "model_id": _MODEL_ID,
        "prompt": item["prompt"],
        "aspect_ratio": clean_text(item.get("aspectRatio")) or _DEFAULT_ASPECT_RATIO,
        "image_size": clean_text(item.get("imageSize")) or _DEFAULT_IMAGE_SIZE,
        "project_id": _PROJECT_ID,
        "request_id": request_id,
        "async": True,
    }
    if reference_urls:
        payload["images"] = reference_urls
    _, response = auth.request("POST", "/ai/image-gen", payload)
    task_id = clean_text(response.get("task_id")) if isinstance(response, dict) else ""
    if not task_id:
        raise RuntimeError("生图提交响应缺少 task_id")
    return task_id


def wait_for_result(
    auth: AuthSession,
    task_id: str,
    on_status,
    timeout_seconds=16 * 60,
    allow_initial_not_found=False,
    not_found_means_not_created=True,
):
    deadline = time.monotonic() + timeout_seconds
    missing_delays = [1, 2, 4, 8, 15] if allow_initial_not_found else None
    while time.monotonic() < deadline:
        try:
            status, payload = auth.request("GET", f"/ai/task-result/{task_id}")
        except APIError as error:
            if error.status != 404 or missing_delays is None:
                raise
            on_status("submission_visibility_check", None)
            if not missing_delays:
                if not_found_means_not_created:
                    raise SubmissionNotFound(
                        f"submission {task_id} was not found after repeated checks"
                    ) from error
                raise
            time.sleep(missing_delays.pop(0))
            continue
        remote_status = clean_text(payload.get("status")) if isinstance(payload, dict) else ""
        queue_position = payload.get("queue_position") if isinstance(payload, dict) else None
        on_status(remote_status or ("processing" if status == 202 else "unknown"), queue_position)
        if status == 200 and remote_status == "completed":
            return payload
        if status == 200 and remote_status in {"failed", "cancelled", "expired"}:
            raise APIError(500, payload)
        if status != 202:
            raise RuntimeError(f"unexpected task response: {status} {payload}")
        time.sleep(3)
    raise TimeoutError(f"task {task_id} exceeded {timeout_seconds} seconds")


def same_origin_image_url(image_url: str, current_url: str | None = None) -> str:
    return same_origin_url(image_url, _BASE_URL, current_url)


def download_image(
    image_url: str,
    output_path: Path,
    output_baseline: object,
    on_install_candidate=None,
) -> None:
    full_url = same_origin_image_url(image_url)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(
        f".{output_path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    request = Request(full_url, headers={"Accept": "image/png,image/*;q=0.8"})
    try:
        try:
            response = _IMAGE_OPENER.open(request, timeout=120)
        except HTTPError as error:
            if error.code in {408, 425, 429, 500, 502, 503, 504}:
                raise NetworkError(f"image download HTTP {error.code}") from error
            raise RuntimeError(f"image download HTTP {error.code}") from error
        except (URLError, TimeoutError, OSError) as error:
            raise NetworkError(str(error)) from error
        with response, temporary.open("wb") as output:
            if not response.headers.get_content_type().startswith("image/"):
                raise RuntimeError(f"{image_url} did not return an image")
            copy_limited_response(
                response,
                output,
                MAX_IMAGE_RESPONSE_BYTES,
                "image download",
            )
            output.flush()
            os.fsync(output.fileno())
        if not valid_png(temporary):
            raise RuntimeError(f"{image_url} did not return a PNG image")
        candidate_snapshot = _install_candidate_file_snapshot(temporary)
        if on_install_candidate is not None:
            on_install_candidate(image_url, candidate_snapshot)
        _install_downloaded_file_without_overwrite(
            temporary,
            output_path,
            output_baseline,
        )
    finally:
        temporary.unlink(missing_ok=True)


def download_first_valid_image(
    image_urls: list[str],
    output_path: Path,
    output_baseline: object,
    on_attempt=None,
    on_install_candidate=None,
) -> str:
    deterministic_errors = []
    uncertain_errors = []
    for image_url in image_urls:
        if on_attempt is not None:
            on_attempt(image_url)
        try:
            download_image(
                image_url,
                output_path,
                output_baseline,
                on_install_candidate=on_install_candidate,
            )
            return image_url
        except OutputConflictError:
            raise
        except NetworkError as error:
            uncertain_errors.append(f"{image_url}: {error}")
        except Exception as error:
            deterministic_errors.append(f"{image_url}: {error}")
    if uncertain_errors:
        raise NetworkError("; ".join((uncertain_errors + deterministic_errors)[:8]))
    detail = "; ".join(deterministic_errors[:8]) or "remote task returned no images"
    raise APIError(
        500,
        {
            "status": "failed",
            "error_code": "image.no_result",
            "failure_code": "image.no_result",
            "message": detail,
        },
    )


def failure_details(error: Exception, attempts: int) -> dict:
    code = ""
    category = ""
    status = None
    if isinstance(error, APIError):
        code = error.code
        category = error.category
        status = error.status
    elif isinstance(error, NetworkError):
        code = "image.network_error"
        category = "network"
    elif isinstance(error, TimeoutError):
        code = "image.timeout"
        category = "timeout"
    retryable = code in _RETRYABLE_CODES or status in {408, 425, 429, 500, 502, 503, 504}
    if code in _TERMINAL_CODES or status in {400, 401, 403}:
        retryable = False
    return {
        "failureCode": code,
        "failureCategory": category,
        "retryable": retryable,
        "terminal": (not retryable) or attempts >= _MAX_IMAGE_ATTEMPTS,
    }
