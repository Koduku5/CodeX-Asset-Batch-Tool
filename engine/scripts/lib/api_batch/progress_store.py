"""Thread-safe persistence for API and directory-redraw batch progress."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Callable


def clean_text(value) -> str:
    return str(value or "").strip()


def normalize_attempt_entry(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    input_fingerprint = clean_text(value.get("inputFingerprint"))
    if not input_fingerprint:
        return None
    attempts = value.get("attempts")
    if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
        attempts = 0
    return {
        "inputFingerprint": input_fingerprint,
        "attempts": attempts,
        "lastError": str(value.get("lastError") or ""),
        "updatedAt": str(value.get("updatedAt") or ""),
    }


def normalize_attempt_ledger(state) -> dict:
    state = state if isinstance(state, dict) else {}
    ledger = {}
    saved_ledger = state.get("attemptLedger")
    if isinstance(saved_ledger, dict):
        for backend in ("builtin", "api"):
            entry = normalize_attempt_entry(saved_ledger.get(backend))
            if entry is not None:
                ledger[backend] = entry
    legacy_backend = state.get("backend")
    if legacy_backend in {"builtin", "api"}:
        input_fingerprint = clean_text(
            state.get("builtinPromptFingerprint")
            if legacy_backend == "builtin"
            else state.get("inputFingerprint")
        )
        if input_fingerprint and ledger.get(legacy_backend, {}).get(
            "inputFingerprint"
        ) != input_fingerprint:
            attempts = state.get("attempts")
            if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
                attempts = 0
            ledger[legacy_backend] = {
                "inputFingerprint": input_fingerprint,
                "attempts": attempts,
                "lastError": str(state.get("error") or ""),
                "updatedAt": str(state.get("updatedAt") or ""),
            }
    return ledger


def attempt_entry_for(ledger: dict, backend: str, input_fingerprint: str) -> dict:
    current = normalize_attempt_entry(ledger.get(backend))
    if current is not None and current["inputFingerprint"] == input_fingerprint:
        return current
    return {
        "inputFingerprint": input_fingerprint,
        "attempts": 0,
        "lastError": "",
        "updatedAt": "",
    }


class ProgressStore:
    def __init__(
        self,
        queue: dict,
        *,
        progress_path: Path,
        progress_version: int,
        directory_redraw_mode: bool,
        read_json: Callable,
        write_json_atomic: Callable,
        queue_operation: Callable[[dict], str],
        base_url: str,
        project_id: str,
        model_id: str,
        aspect_ratio: str,
        image_size: str,
        api_execution_fingerprint: Callable[[], str],
    ):
        value = read_json(progress_path, fallback={"version": progress_version, "items": {}})
        if not isinstance(value, dict):
            raise SystemExit("出图进度顶层必须是对象")
        if not isinstance(value.get("items"), dict):
            raise SystemExit("出图进度 items 必须是对象")
        if directory_redraw_mode and value["items"]:
            if (
                value.get("version") != 1
                or value.get("operation") != "directory_redraw"
                or clean_text(value.get("batchId")) != clean_text(queue.get("batchId"))
                or clean_text(value.get("queueFingerprint"))
                != clean_text(queue.get("queueFingerprint"))
            ):
                raise SystemExit("批量重绘进度与当前队列的批次或指纹不一致，禁止收养旧任务状态")
        value["version"] = 1 if directory_redraw_mode else progress_version
        if directory_redraw_mode:
            value["operation"] = "directory_redraw"
            value["batchId"] = queue["batchId"]
            value["queueFingerprint"] = queue["queueFingerprint"]
        else:
            value["routingFingerprint"] = queue["routingFingerprint"]
        self.value = value
        self.mutex = threading.Lock()
        self._progress_path = progress_path
        self._directory_redraw_mode = directory_redraw_mode
        self._write_json_atomic = write_json_atomic
        self._queue_operation = queue_operation
        self._base_url = base_url
        self._project_id = project_id
        self._model_id = model_id
        self._aspect_ratio = aspect_ratio
        self._image_size = image_size
        self._api_execution_fingerprint = api_execution_fingerprint

    def get(self, key: str) -> dict:
        with self.mutex:
            state = self.value["items"].get(key)
            return dict(state) if isinstance(state, dict) else {}

    def set(self, key: str, state: dict) -> None:
        with self.mutex:
            next_state = dict(state)
            if not self._directory_redraw_mode:
                previous = self.value["items"].get(key)
                merged_ledger = normalize_attempt_ledger(previous)
                incoming_ledger = normalize_attempt_ledger(next_state)
                for backend, entry in incoming_ledger.items():
                    merged_ledger[backend] = entry
                backend = next_state.get("backend")
                if backend in {"builtin", "api"}:
                    input_fingerprint = clean_text(
                        next_state.get("builtinPromptFingerprint")
                        if backend == "builtin"
                        else next_state.get("inputFingerprint")
                    )
                    if input_fingerprint:
                        attempts = next_state.get("attempts")
                        if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
                            attempts = 0
                        merged_ledger[backend] = {
                            "inputFingerprint": input_fingerprint,
                            "attempts": attempts,
                            "lastError": str(next_state.get("error") or ""),
                            "updatedAt": str(next_state.get("updatedAt") or ""),
                        }
                next_state["attemptLedger"] = merged_ledger
            self.value["items"][key] = next_state
            self._write_json_atomic(self._progress_path, self.value)

    def snapshot(self) -> dict:
        with self.mutex:
            return json.loads(json.dumps(self.value, ensure_ascii=False))

    def set_batch_configuration(self, queue: dict) -> None:
        with self.mutex:
            api_batch = self.value.get("apiBatch")
            api_batch = dict(api_batch) if isinstance(api_batch, dict) else {}
            api_batch["configuration"] = {
                "operation": self._queue_operation(queue),
                "baseUrl": self._base_url,
                "projectId": self._project_id,
                "modelId": self._model_id,
                "aspectRatio": self._aspect_ratio,
                "imageSize": self._image_size,
                "executionFingerprint": self._api_execution_fingerprint(),
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            if self._directory_redraw_mode:
                api_batch["configuration"].update(
                    {
                        "sourceRoot": queue["sourceRoot"],
                        "outputRoot": queue["outputRoot"],
                        "promptFingerprint": queue["promptFingerprint"],
                        "batchId": queue["batchId"],
                        "queueFingerprint": queue["queueFingerprint"],
                    }
                )
            self.value["apiBatch"] = api_batch
            self._write_json_atomic(self._progress_path, self.value)

    def set_canvas_status(
        self,
        status: str,
        *,
        error: str = "",
        nodes: int | None = None,
        edges: int | None = None,
    ) -> None:
        with self.mutex:
            api_batch = self.value.get("apiBatch")
            api_batch = dict(api_batch) if isinstance(api_batch, dict) else {}
            api_batch.update(
                {
                    "canvasStatus": status,
                    "canvasError": clean_text(error)[:2000],
                    "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            )
            if nodes is not None:
                api_batch["nodes"] = nodes
            if edges is not None:
                api_batch["edges"] = edges
            self.value["apiBatch"] = api_batch
            self._write_json_atomic(self._progress_path, self.value)
