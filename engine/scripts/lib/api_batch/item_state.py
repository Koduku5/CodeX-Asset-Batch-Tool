"""Queue-item progress selection and interrupted-download reconciliation."""

from __future__ import annotations

from pathlib import Path

from api_batch.file_runtime import (
    file_snapshot,
    install_candidate_file_snapshot,
    normalize_install_candidate_snapshot,
)
from api_batch.image_validation import valid_png
from api_batch.progress_store import (
    ProgressStore,
    attempt_entry_for,
    clean_text,
    normalize_attempt_ledger,
)


DIRECTORY_REDRAW_MODE = False
ONLY_KEY = ""


def configure_item_state(*, directory_redraw_mode: bool, only_key: str) -> None:
    global DIRECTORY_REDRAW_MODE, ONLY_KEY
    DIRECTORY_REDRAW_MODE = directory_redraw_mode
    ONLY_KEY = only_key


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
