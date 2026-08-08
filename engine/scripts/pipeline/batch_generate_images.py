#!/usr/bin/env python3
"""Run the current asset queue through the IntinifyCanvas image API."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import socket
import stat as stat_module
import sys
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
sys.dont_write_bytecode = True
sys.path.insert(0, str(LIB_DIR))

from api_security import (  # noqa: E402
    SameOriginRedirectHandler,
    normalize_base_url,
    require_secure_transport,
    resolves_only_to_private_addresses,
    same_origin_url,
)
from bounded_io import (  # noqa: E402
    InvalidJsonResponseError,
    MAX_API_ERROR_RESPONSE_BYTES,
    MAX_API_JSON_RESPONSE_BYTES,
    MAX_IMAGE_RESPONSE_BYTES,
    ResponseTooLargeError,
    copy_limited_response,
    decode_strict_json_bytes,
    read_limited_bytes,
)
from api_batch.image_validation import (  # noqa: E402
    read_stable_reference_bytes,
    valid_png,
    valid_reference_image,
)
from api_batch.canvas_layout import save_canvas_nodes  # noqa: E402
from api_batch.progress_store import (  # noqa: E402
    ProgressStore,
    attempt_entry_for,
    clean_text,
    normalize_attempt_ledger,
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
REFERENCE_HASH_CACHE: dict[tuple[str, int, int], str] = {}
REFERENCE_HASH_MUTEX = threading.Lock()


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
DIRECTORY_REDRAW_SOURCE_ROOT: Path | None = None
DIRECTORY_REDRAW_OUTPUT_ROOT: Path | None = None

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


def proxy_handler() -> ProxyHandler:
    return ProxyHandler({}) if DIRECT_API_CONNECTION else ProxyHandler()


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


class BatchLock:
    def __init__(self, payload: dict, handle):
        self.payload = payload
        self.handle = handle

    def get(self, key: str, default=None):
        return self.payload.get(key, default)


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
    if DIRECTORY_REDRAW_MODE:
        root = DIRECTORY_REDRAW_OUTPUT_ROOT
        if root is None:
            raise ValueError("directory redraw output root is not configured")
        target = (root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    else:
        root = IMAGE_OUTPUT_ROOT
        target = (SKILL_ROOT / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
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
    with REFERENCE_HASH_MUTEX:
        cached = REFERENCE_HASH_CACHE.get(key)
    if cached:
        return cached
    digest, _ = stable_file_sha256(path, stat)
    with REFERENCE_HASH_MUTEX:
        stale = [entry for entry in REFERENCE_HASH_CACHE if entry[0] == key[0]]
        for entry in stale:
            REFERENCE_HASH_CACHE.pop(entry, None)
        REFERENCE_HASH_CACHE[key] = digest
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


def valid_api_prompt_batch(queue: dict) -> bool:
    prompt_batch = queue.get("apiPromptBatch")
    return (
        isinstance(prompt_batch, dict)
        and set(prompt_batch) == {"version", "confirmedAt", "bySheet"}
        and prompt_batch.get("version") == 2
        and bool(clean_text(prompt_batch.get("confirmedAt")))
        and isinstance(prompt_batch.get("bySheet"), dict)
        and set(prompt_batch["bySheet"]) == set(IMAGE_SHEET_ORDER)
        and all(isinstance(prompt_batch["bySheet"].get(name), str) for name in IMAGE_SHEET_ORDER)
    )


def queue_operation(queue: dict) -> str:
    operation = clean_text(queue.get("operation")) or "generate"
    if operation not in {"generate", "reference_redraw", "directory_redraw"}:
        raise SystemExit(f"出图队列 operation 无效：{operation}")
    return operation


def validate_reference_redraw_structure(queue: dict) -> None:
    metadata = queue.get("referenceRedraw")
    if not isinstance(metadata, dict) or set(metadata) != {
        "version",
        "batchId",
        "sourceRoot",
        "outputRoot",
        "candidateCount",
        "sourceCount",
        "skippedMissingSources",
    }:
        raise SystemExit("API 重绘队列缺少有效的 referenceRedraw 元数据")
    batch_id = clean_text(metadata.get("batchId"))
    if (
        metadata.get("version") != 1
        or not batch_id.startswith("batch-")
        or len(batch_id) != 23
        or not batch_id[6:].isdigit()
        or metadata.get("sourceRoot") != "输出/资产图"
        or metadata.get("outputRoot") != f"输出/资产图/API重绘/{batch_id}"
        or not isinstance(metadata.get("candidateCount"), int)
        or not isinstance(metadata.get("sourceCount"), int)
        or not isinstance(metadata.get("skippedMissingSources"), list)
        or metadata["sourceCount"] != len(queue.get("items", []))
        or metadata["candidateCount"]
        != metadata["sourceCount"] + len(metadata["skippedMissingSources"])
    ):
        raise SystemExit("API 重绘队列 referenceRedraw 元数据无效")
    if not queue.get("items"):
        raise SystemExit("API 重绘队列没有可执行任务")

    redraw_base_root = (IMAGE_OUTPUT_ROOT / "API重绘").resolve()
    redraw_root = (redraw_base_root / batch_id).resolve()
    for item in queue["items"]:
        references = item.get("references")
        snapshots = item.get("referenceSnapshots")
        if item.get("operation") != "reference_redraw":
            raise SystemExit(f"API 重绘任务缺少 operation：{item.get('key', '未知任务')}")
        if not isinstance(references, list) or len(references) != 1:
            raise SystemExit(f"API 重绘任务必须且只能绑定一张原图：{item.get('key', '未知任务')}")
        if not isinstance(snapshots, list) or len(snapshots) != 1:
            raise SystemExit(f"API 重绘任务缺少原图快照：{item.get('key', '未知任务')}")
        snapshot = snapshots[0]
        if (
            not isinstance(snapshot, dict)
            or set(snapshot) != {"path", "size", "sha256"}
            or snapshot.get("path") != references[0]
            or not isinstance(snapshot.get("size"), int)
            or snapshot["size"] <= 0
            or snapshot["size"] > 20 * 1024 * 1024
            or not isinstance(snapshot.get("sha256"), str)
            or len(snapshot["sha256"]) != 64
        ):
            raise SystemExit(f"API 重绘任务原图快照无效：{item.get('key', '未知任务')}")
        try:
            reference_path = resolve_skill_file(references[0], "reference")
            output_path = resolve_output(item.get("outputPath", ""))
        except ValueError as error:
            raise SystemExit(str(error)) from error
        if not is_within(reference_path, IMAGE_OUTPUT_ROOT) or is_within(
            reference_path, redraw_base_root
        ):
            raise SystemExit(f"API 重绘原图必须位于标准资产图分类目录：{references[0]}")
        if not is_within(output_path, redraw_root):
            raise SystemExit(f"API 重绘结果必须写入 输出/资产图/API重绘：{item.get('outputPath')}")
        if os.path.normcase(str(reference_path)) == os.path.normcase(str(output_path)):
            raise SystemExit(f"API 重绘结果禁止覆盖原图：{references[0]}")


def is_sha256(value) -> bool:
    text = clean_text(value).lower()
    return len(text) == 64 and all(character in "0123456789abcdef" for character in text)


def safe_relative_parts(value: str, label: str) -> tuple[str, ...]:
    text = str(value or "").replace("\\", "/")
    pure = PurePosixPath(text)
    if (
        not text
        or pure.is_absolute()
        or str(pure) != text
        or any(part in {"", ".", ".."} or ":" in part for part in pure.parts)
    ):
        raise SystemExit(f"{label}不是安全相对路径：{value}")
    return pure.parts


def validate_directory_redraw_structure(queue: dict) -> None:
    global DIRECTORY_REDRAW_SOURCE_ROOT, DIRECTORY_REDRAW_OUTPUT_ROOT

    required_fields = {
        "version",
        "operation",
        "batchId",
        "builtAt",
        "sourceRoot",
        "outputRoot",
        "prompt",
        "promptFingerprint",
        "recursive",
        "candidateCount",
        "sourceCount",
        "skipped",
        "items",
        "queueFingerprint",
    }
    if set(queue) != required_fields:
        raise SystemExit("文件夹批量重绘队列字段无效，请重新建立")
    batch_id = clean_text(queue.get("batchId"))
    prompt = normalize_prompt_text(queue.get("prompt"))
    if (
        queue.get("version") != 1
        or queue.get("operation") != "directory_redraw"
        or not batch_id
        or not clean_text(queue.get("builtAt"))
        or not prompt
        or queue.get("prompt") != prompt
        or not is_sha256(queue.get("promptFingerprint"))
        or queue.get("recursive") is not True
        or not isinstance(queue.get("candidateCount"), int)
        or not isinstance(queue.get("sourceCount"), int)
        or not isinstance(queue.get("skipped"), list)
        or not isinstance(queue.get("items"), list)
        or not is_sha256(queue.get("queueFingerprint"))
        or queue["sourceCount"] != len(queue["items"])
        or queue["candidateCount"] != queue["sourceCount"] + len(queue["skipped"])
    ):
        raise SystemExit("文件夹批量重绘队列结构无效，请重新建立")
    if not queue["items"]:
        raise SystemExit("文件夹批量重绘队列没有可执行图片")

    source_root_value = Path(clean_text(queue.get("sourceRoot")))
    output_root_value = Path(clean_text(queue.get("outputRoot")))
    if not source_root_value.is_absolute() or not output_root_value.is_absolute():
        raise SystemExit("文件夹批量重绘的原图与结果目录必须是绝对路径")
    source_root = require_stable_real_directory(source_root_value, "文件夹批量重绘原图目录")
    output_root = require_stable_real_directory(output_root_value, "文件夹批量重绘结果目录")
    if source_root == Path(source_root.anchor) or output_root == Path(output_root.anchor):
        raise SystemExit("禁止把磁盘根目录作为批量重绘目录")
    if not source_root.is_dir() or not output_root.is_dir():
        raise SystemExit("文件夹批量重绘的原图或结果目录不存在")
    skill_root = SKILL_ROOT.resolve()
    if (
        is_within(source_root, skill_root)
        or is_within(skill_root, source_root)
        or is_within(output_root, skill_root)
        or is_within(skill_root, output_root)
    ):
        raise SystemExit("原图和结果目录必须与 Skill 项目目录完全分离")
    if is_within(source_root, output_root) or is_within(output_root, source_root):
        raise SystemExit("原图目录与结果目录不能相同或互相嵌套")
    DIRECTORY_REDRAW_SOURCE_ROOT = source_root
    DIRECTORY_REDRAW_OUTPUT_ROOT = output_root

    if clean_text(queue.get("promptFingerprint")) != canonical_fingerprint({"prompt": prompt}):
        raise SystemExit("文件夹批量重绘提示词指纹无效")

    keys = set()
    for index, item in enumerate(queue["items"], start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"文件夹批量重绘队列第 {index} 项不是对象")
        required_item_fields = {
            "key",
            "sourceRelativePath",
            "outputRelativePath",
            "sourceSnapshot",
            "prompt",
            "inputFingerprint",
        }
        if set(item) != required_item_fields:
            raise SystemExit(f"文件夹批量重绘队列第 {index} 项字段无效")
        key = clean_text(item.get("key"))
        if not key or key in keys:
            raise SystemExit(f"文件夹批量重绘任务 key 缺失或重复：{key or index}")
        keys.add(key)
        source_relative = str(item.get("sourceRelativePath") or "")
        output_relative = str(item.get("outputRelativePath") or "")
        source_parts = safe_relative_parts(source_relative, f"任务 {key} 原图路径")
        output_parts = safe_relative_parts(output_relative, f"任务 {key} 输出路径")
        reject_reparse_segments(source_root, source_parts, f"任务 {key} 原图路径")
        reject_reparse_segments(output_root, output_parts, f"任务 {key} 输出路径")
        source_path = (source_root.joinpath(*source_parts)).resolve()
        output_path = (output_root.joinpath(*output_parts)).resolve()
        if not is_within(source_path, source_root) or not is_within(output_path, output_root):
            raise SystemExit(f"文件夹批量重绘任务路径越界：{key}")
        expected_output = PurePosixPath(source_relative).with_suffix(".png").as_posix()
        if output_relative != expected_output:
            raise SystemExit(f"文件夹批量重绘输出路径与原图层级不一致：{key}")
        snapshot = item.get("sourceSnapshot")
        if (
            not isinstance(snapshot, dict)
            or set(snapshot) != {"size", "sha256"}
            or not isinstance(snapshot.get("size"), int)
            or snapshot["size"] <= 0
            or snapshot["size"] > 20 * 1024 * 1024
            or not is_sha256(snapshot.get("sha256"))
            or normalize_prompt_text(item.get("prompt")) != prompt
        ):
            raise SystemExit(f"文件夹批量重绘任务快照或提示词无效：{key}")
        expected_input = canonical_fingerprint(
            {
                "operation": "directory_redraw",
                "outputRelativePath": output_relative,
                "promptFingerprint": queue["promptFingerprint"],
                "sourceRelativePath": source_relative,
                "sourceSnapshot": snapshot,
            }
        )
        if clean_text(item.get("inputFingerprint")) != expected_input:
            raise SystemExit(f"文件夹批量重绘任务输入指纹无效：{key}")

        # Normalize the dedicated queue item into the fields reused by the API executor.
        item["assetName"] = source_relative
        item["outputPath"] = output_relative
        item["references"] = [source_relative]
        item["referenceSnapshots"] = [
            {"path": source_relative, "size": snapshot["size"], "sha256": snapshot["sha256"]}
        ]

    expected_queue_fingerprint = canonical_fingerprint(
        {
            "version": 1,
            "operation": "directory_redraw",
            "sourceRoot": queue["sourceRoot"],
            "outputRoot": queue["outputRoot"],
            "promptFingerprint": queue["promptFingerprint"],
            "recursive": True,
            "items": [
                {
                    "key": item["key"],
                    "sourceRelativePath": item["sourceRelativePath"],
                    "outputRelativePath": item["outputRelativePath"],
                    "sourceSnapshot": item["sourceSnapshot"],
                    "inputFingerprint": item["inputFingerprint"],
                }
                for item in queue["items"]
            ],
            "skipped": queue["skipped"],
        }
    )
    if clean_text(queue.get("queueFingerprint")) != expected_queue_fingerprint:
        raise SystemExit("文件夹批量重绘队列指纹无效")


def validate_new_api_queue_items(queue: dict) -> None:
    prompt_batch = queue["apiPromptBatch"]
    operation = queue_operation(queue)
    try:
        route_path = resolve_skill_file(queue.get("routingConfig", ""), "routingConfig")
        routes = read_json(route_path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"API 出图路由无法读取：{error}") from error
    if (
        not isinstance(routes, dict)
        or routes.get("version") != 1
        or routes.get("sheetOrder") != list(IMAGE_SHEET_ORDER)
        or not isinstance(routes.get("routes"), dict)
        or set(routes["routes"]) != set(IMAGE_SHEET_ORDER)
    ):
        raise SystemExit("API 出图路由结构无效")

    route_fingerprints = {}
    for sheet_name in IMAGE_SHEET_ORDER:
        route = routes["routes"].get(sheet_name)
        if not isinstance(route, dict) or set(route) != {"outputFolder"} or not clean_text(
            route.get("outputFolder")
        ):
            raise SystemExit(f"API 出图路由缺少有效分类：{sheet_name}")
        route_fingerprints[sheet_name] = json_fingerprint(
            {
                "sheetName": sheet_name,
                "route": route,
                "promptTemplate": prompt_batch["bySheet"][sheet_name],
            }
        )

    for item in queue["items"]:
        sheet_name = item.get("sheetName")
        if sheet_name not in IMAGE_SHEET_ORDER or not isinstance(item.get("productionNotes"), str):
            raise SystemExit(f"API 队列项目分类或制作说明无效：{item.get('key', '未知任务')}")
        expected_prompt = "\n\n".join(
            part
            for part in (
                normalize_prompt_text(prompt_batch["bySheet"][sheet_name]),
                normalize_prompt_text(item["productionNotes"]),
            )
            if part
        )
        if not expected_prompt or normalize_prompt_text(item.get("prompt")) != expected_prompt:
            raise SystemExit(f"API 队列 Prompt 与窗口模板快照不一致：{item.get('key', '未知任务')}")

        expected_asset_fingerprint = json_fingerprint(
            {
                "version": 1,
                "sheetName": clean_text(sheet_name),
                "assetId": clean_text(item.get("assetId")),
                "assetName": clean_text(item.get("assetName")),
                "productionNotes": clean_text(item.get("productionNotes")),
                "outputPath": clean_text(item.get("outputPath")),
            }
        )
        if clean_text(item.get("assetFingerprint")) != expected_asset_fingerprint:
            raise SystemExit(f"API 队列资产指纹无效：{item.get('key', '未知任务')}")

        input_payload = {
            "sheetName": sheet_name,
            "assetId": item.get("assetId"),
            "assetName": item.get("assetName"),
            "productionNotes": item.get("productionNotes"),
            "prompt": item.get("prompt"),
            "routeFingerprint": route_fingerprints[sheet_name],
        }
        if operation == "reference_redraw":
            input_payload.update(
                {
                    "operation": "reference_redraw",
                    "references": item.get("references"),
                    "referenceSnapshots": item.get("referenceSnapshots"),
                }
            )
        expected_input_fingerprint = json_fingerprint(input_payload)
        if clean_text(item.get("inputFingerprint")) != expected_input_fingerprint:
            raise SystemExit(f"API 队列输入指纹无效：{item.get('key', '未知任务')}")


def load_queue() -> dict:
    queue = read_json(QUEUE_PATH)
    if not isinstance(queue, dict):
        raise SystemExit("出图队列结构无效，请重新建立出图队列")
    declared_operation = clean_text(queue.get("operation")) or "generate"
    expected_version = 1 if declared_operation == "directory_redraw" else QUEUE_VERSION
    if queue.get("version") != expected_version:
        raise SystemExit("出图队列结构无效，请重新建立出图队列")
    items = queue.get("items")
    if not isinstance(items, list):
        raise SystemExit("出图队列 items 必须是数组")
    operation = queue_operation(queue)
    if DIRECTORY_REDRAW_MODE != (operation == "directory_redraw"):
        raise SystemExit("批量执行模式与队列类型不一致")
    if ONLY_KEY and operation != "generate":
        raise SystemExit("--only-key 只适用于普通 API 资产出图")
    if operation == "directory_redraw":
        validate_directory_redraw_structure(queue)
    else:
        validated_image_root = require_stable_real_directory(
            IMAGE_OUTPUT_ROOT_PATH,
            "资产图输出目录",
        )
        if os.path.normcase(str(validated_image_root)) != os.path.normcase(
            str(IMAGE_OUTPUT_ROOT)
        ):
            raise SystemExit("资产图输出目录真实路径已变化，请重新建立出图队列")
        required_root = (
            "builtAt",
            "routingFingerprint",
            "eligibilityFingerprint",
        )
        if any(not clean_text(queue.get(field)) for field in required_root):
            raise SystemExit("出图队列尚未建立，请先运行 build_image_queue.mjs")
    if operation == "reference_redraw":
        validate_reference_redraw_structure(queue)
    elif operation != "directory_redraw" and "referenceRedraw" in queue:
        raise SystemExit("普通出图队列不应包含 referenceRedraw 元数据")
    prompt_batch_valid = operation != "directory_redraw" and valid_api_prompt_batch(queue)
    if operation != "directory_redraw" and not prompt_batch_valid:
        old_progress = read_json(PROGRESS_PATH, fallback={"items": {}})
        old_items = old_progress.get("items", {}) if isinstance(old_progress, dict) else {}
        queue_items_by_key = {
            clean_text(item.get("key")): item for item in items if isinstance(item, dict)
        }
        has_legacy_api_state = (
            isinstance(old_progress, dict)
            and clean_text(old_progress.get("routingFingerprint"))
            == clean_text(queue.get("routingFingerprint"))
            and isinstance(old_items, dict)
            and any(
                isinstance(state, dict)
                and state.get("backend") == "api"
                and state.get("status") in {"generating", "completed", "failed"}
                and key in queue_items_by_key
                and clean_text(state.get("inputFingerprint"))
                == clean_text(queue_items_by_key[key].get("inputFingerprint"))
                for key, state in old_items.items()
            )
        )
        if not has_legacy_api_state:
            raise SystemExit("API 提示词模板尚未在 API 批量窗口确认")
    keys = set()
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"出图队列第 {index} 项不是对象")
        required_item_fields = (
            ("key", "assetName", "prompt", "outputPath", "inputFingerprint")
            if operation == "directory_redraw"
            else ("key", "assetId", "assetName", "prompt", "outputPath", "inputFingerprint")
        )
        for field in required_item_fields:
            if not clean_text(item.get(field)):
                raise SystemExit(f"出图队列第 {index} 项缺少 {field}")
        if item["key"] in keys:
            raise SystemExit(f"出图队列存在重复 key：{item['key']}")
        keys.add(item["key"])
        resolve_output(item["outputPath"])
        references = item.get("references", [])
        if not isinstance(references, list) or any(not isinstance(value, str) for value in references):
            raise SystemExit(f"任务 {item['key']} references 必须是字符串数组")
    if prompt_batch_valid:
        validate_new_api_queue_items(queue)
    return queue


def resolve_skill_file(relative_path: str, label: str) -> Path:
    if not clean_text(relative_path):
        raise ValueError(f"{label} path is empty")
    target = (SKILL_ROOT / relative_path).resolve()
    try:
        common = Path(os.path.commonpath([str(target), str(SKILL_ROOT)]))
    except ValueError as error:
        raise ValueError(f"{label} path escapes Skill root: {relative_path}") from error
    if os.path.normcase(str(common)) != os.path.normcase(str(SKILL_ROOT)):
        raise ValueError(f"{label} path escapes Skill root: {relative_path}")
    return target


def resolve_reference_file(relative_path: str) -> Path:
    if not DIRECTORY_REDRAW_MODE:
        return resolve_skill_file(relative_path, "reference")
    if DIRECTORY_REDRAW_SOURCE_ROOT is None:
        raise ValueError("directory redraw source root is not configured")
    parts = safe_relative_parts(relative_path, "批量重绘原图路径")
    target = DIRECTORY_REDRAW_SOURCE_ROOT.joinpath(*parts).resolve()
    if not is_within(target, DIRECTORY_REDRAW_SOURCE_ROOT):
        raise ValueError(f"reference path escapes configured source root: {relative_path}")
    return target


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reference_freshness_errors(queue: dict) -> list[str]:
    if queue_operation(queue) not in {"reference_redraw", "directory_redraw"}:
        return []
    errors = []
    for item in queue.get("items", []):
        key = clean_text(item.get("key")) or "未知任务"
        references = item.get("references", [])
        snapshots = item.get("referenceSnapshots", [])
        if len(references) != 1 or len(snapshots) != 1:
            errors.append(f"{key} 原图结构无效")
            continue
        snapshot = snapshots[0]
        try:
            reference = resolve_reference_file(references[0])
            stat = reference.stat()
            if not reference.is_file():
                errors.append(f"{key} 原图不是文件")
                continue
            if stat.st_size != snapshot.get("size"):
                errors.append(f"{key} 原图大小已变化")
                continue
            if cached_file_sha256(reference) != snapshot.get("sha256"):
                errors.append(f"{key} 原图内容已变化")
                continue
            if not valid_reference_image(reference):
                errors.append(f"{key} 原图不是支持的有效图片")
        except (OSError, ValueError) as error:
            errors.append(f"{key} 原图无法读取：{error}")
    return errors


def queue_freshness_errors(queue: dict) -> list[str]:
    if queue_operation(queue) == "directory_redraw":
        errors = reference_freshness_errors(queue)
        if DIRECTORY_REDRAW_OUTPUT_ROOT is None or not DIRECTORY_REDRAW_OUTPUT_ROOT.is_dir():
            errors.append("批量重绘结果目录不存在")
        return list(dict.fromkeys(errors))

    errors = []
    pending_path = CACHE_DIR / "待确认记录.json"
    try:
        if file_sha256(pending_path) != queue.get("eligibilityFingerprint"):
            errors.append("待确认记录已变化")
    except OSError:
        errors.append("待确认记录不存在或无法读取")

    # 旧队列的最终 Prompt 与输出路径已经冻结在每个任务中。它记录的前缀、
    # 风格锚点等外部文件已退出新流程，恢复或重试旧远端任务时不应再依赖它们。
    if valid_api_prompt_batch(queue):
        resources = queue.get("routingResourceFingerprints")
        if not isinstance(resources, dict) or not resources:
            errors.append("队列缺少路由资源指纹")
        else:
            for relative_path, expected in resources.items():
                try:
                    resource = resolve_skill_file(relative_path, "routing resource")
                    if file_sha256(resource) != expected:
                        errors.append(f"出图路由资源已变化：{relative_path}")
                except (OSError, ValueError):
                    errors.append(f"出图路由资源缺失：{relative_path}")

    errors.extend(reference_freshness_errors(queue))
    return list(dict.fromkeys(errors))


def queue_execution_fingerprint(queue: dict) -> str:
    item_payloads = []
    for item in queue.get("items", []):
        payload = {
            "key": item.get("key"),
            "inputFingerprint": item.get("inputFingerprint"),
            "prompt": item.get("prompt"),
            "outputPath": item.get("outputPath"),
        }
        if "references" in item:
            payload["references"] = item.get("references")
        if "referenceSnapshots" in item:
            payload["referenceSnapshots"] = item.get("referenceSnapshots")
        item_payloads.append(payload)
    payload = {
        "builtAt": queue.get("builtAt"),
        "routingFingerprint": queue.get("routingFingerprint"),
        "eligibilityFingerprint": queue.get("eligibilityFingerprint"),
        "apiExecutionFingerprint": api_execution_fingerprint(),
        "items": item_payloads,
    }
    if "operation" in queue:
        payload["operation"] = queue.get("operation")
    if "referenceRedraw" in queue:
        payload["referenceRedraw"] = queue.get("referenceRedraw")
    if queue_operation(queue) == "directory_redraw":
        payload["directoryRedraw"] = {
            field: queue.get(field)
            for field in (
                "batchId",
                "sourceRoot",
                "outputRoot",
                "promptFingerprint",
                "queueFingerprint",
            )
        }
    if isinstance(queue.get("apiPromptBatch"), dict):
        payload["apiPromptBatch"] = queue["apiPromptBatch"]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def api_execution_fingerprint() -> str:
    payload = {
        "baseUrl": BASE_URL,
        "projectId": PROJECT_ID,
        "modelId": MODEL_ID,
        "aspectRatio": DEFAULT_ASPECT_RATIO,
        "imageSize": DEFAULT_IMAGE_SIZE,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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


def read_json_response(response):
    raw = read_limited_bytes(
        response,
        MAX_API_JSON_RESPONSE_BYTES,
        "API JSON response",
    )
    return decode_strict_json_bytes(raw, "API JSON response")


def open_json(request: Request, timeout=120):
    try:
        with API_OPENER.open(request, timeout=timeout) as response:
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
    request = Request(API_URL + path, data=data, headers=headers, method=method)
    return open_json(request, timeout=timeout)


def login() -> str:
    _, payload = json_request(
        "POST",
        "/auth/login",
        payload={"username": USERNAME, "password": PASSWORD},
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
    path = resolve_reference_file(file_name)
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
        f"{PROJECT_ID}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    body = prefix + image_bytes + suffix
    token = auth.token()
    for attempt in range(2):
        request = Request(
            API_URL + "/images/upload",
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
        "model_id": MODEL_ID,
        "prompt": item["prompt"],
        "aspect_ratio": clean_text(item.get("aspectRatio")) or DEFAULT_ASPECT_RATIO,
        "image_size": clean_text(item.get("imageSize")) or DEFAULT_IMAGE_SIZE,
        "project_id": PROJECT_ID,
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
    return same_origin_url(image_url, BASE_URL, current_url)


API_OPENER = build_opener(proxy_handler(), SameOriginRedirectHandler(BASE_URL))
IMAGE_OPENER = build_opener(proxy_handler(), SameOriginRedirectHandler(BASE_URL))


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
            response = IMAGE_OPENER.open(request, timeout=120)
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
        candidate_snapshot = install_candidate_file_snapshot(temporary)
        if on_install_candidate is not None:
            on_install_candidate(image_url, candidate_snapshot)
        install_downloaded_file_without_overwrite(
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
    retryable = code in RETRYABLE_CODES or status in {408, 425, 429, 500, 502, 503, 504}
    if code in TERMINAL_CODES or status in {400, 401, 403}:
        retryable = False
    return {
        "failureCode": code,
        "failureCategory": category,
        "retryable": retryable,
        "terminal": (not retryable) or attempts >= MAX_IMAGE_ATTEMPTS,
    }


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
