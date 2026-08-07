"""Bounded byte-stream helpers for untrusted HTTP responses."""

from __future__ import annotations

import json
from typing import BinaryIO


READ_CHUNK_BYTES = 64 * 1024
MAX_API_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_API_ERROR_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024


class ResponseTooLargeError(RuntimeError):
    """Raised before an untrusted response can exceed its byte budget."""


class InvalidJsonResponseError(RuntimeError):
    """Raised when an API JSON response is not strict UTF-8 JSON."""


def decode_strict_json_bytes(payload: bytes, label: str):
    """Decode JSON only from strict UTF-8 bytes; reject UTF-16/32 auto-detection."""

    if not payload:
        return {}
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise InvalidJsonResponseError(f"{label} is not valid UTF-8") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise InvalidJsonResponseError(f"{label} is not valid JSON") from exc


def _declared_content_length(response) -> int | None:
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        value = headers.get("Content-Length")
    except (AttributeError, KeyError, TypeError):
        return None
    if value is None or not str(value).strip():
        return None
    try:
        length = int(str(value).strip(), 10)
    except ValueError:
        return None
    return length if length >= 0 else None


def _validate_limit(response, max_bytes: int, label: str) -> None:
    if not isinstance(max_bytes, int) or max_bytes <= 0:
        raise ValueError("max_bytes must be a positive integer")
    declared = _declared_content_length(response)
    if declared is not None and declared > max_bytes:
        raise ResponseTooLargeError(
            f"{label} declares {declared} bytes; limit is {max_bytes} bytes"
        )


def _read_chunks(response, max_bytes: int, label: str):
    _validate_limit(response, max_bytes, label)
    total = 0
    while True:
        requested = min(READ_CHUNK_BYTES, max_bytes - total + 1)
        chunk = response.read(requested)
        if not chunk:
            return
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError(f"{label} returned a non-byte response chunk")
        chunk = bytes(chunk)
        if len(chunk) > max_bytes - total:
            raise ResponseTooLargeError(f"{label} exceeds {max_bytes} bytes")
        total += len(chunk)
        yield chunk


def read_limited_bytes(response, max_bytes: int, label: str) -> bytes:
    """Read a response completely without accepting more than ``max_bytes``."""

    return b"".join(_read_chunks(response, max_bytes, label))


def copy_limited_response(
    response,
    destination: BinaryIO,
    max_bytes: int,
    label: str,
) -> int:
    """Copy a response to a binary stream while enforcing a hard byte limit."""

    written = 0
    for chunk in _read_chunks(response, max_bytes, label):
        destination.write(chunk)
        written += len(chunk)
    return written
