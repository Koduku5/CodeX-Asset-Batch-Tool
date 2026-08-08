"""Batch-level canvas projection and bounded concurrent execution."""

from __future__ import annotations

import json
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from api_batch.file_runtime import resolve_output
from api_batch.image_validation import valid_png
from api_batch.item_runner import run_item
from api_batch.progress_store import ProgressStore, clean_text
from api_batch.remote_client import AuthSession, SubmissionGate


MAX_WORKERS = 1
BASE_URL = ""
PROJECT_ID = ""
MODEL_ID = ""
DEFAULT_ASPECT_RATIO = ""
DEFAULT_IMAGE_SIZE = ""


def configure_batch_execution(
    *,
    max_workers: int,
    base_url: str,
    project_id: str,
    model_id: str,
    default_aspect_ratio: str,
    default_image_size: str,
) -> None:
    """Configure concurrency and the identity recorded in canvas projections."""
    global MAX_WORKERS, BASE_URL, PROJECT_ID, MODEL_ID
    global DEFAULT_ASPECT_RATIO, DEFAULT_IMAGE_SIZE

    MAX_WORKERS = max_workers
    BASE_URL = base_url
    PROJECT_ID = project_id
    MODEL_ID = model_id
    DEFAULT_ASPECT_RATIO = default_aspect_ratio
    DEFAULT_IMAGE_SIZE = default_image_size


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

