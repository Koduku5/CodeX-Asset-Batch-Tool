"""Bounded, stable structural checks for locally supplied image files."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

MAX_IMAGE_PIXELS = 24 * 1024 * 1024


def dimensions_are_safe(width: int, height: int) -> bool:
    return width > 0 and height > 0 and width <= MAX_IMAGE_PIXELS // height


def valid_jpeg_bytes(raw: bytes) -> bool:
    if len(raw) < 16 or not raw.startswith(b"\xff\xd8") or not raw.endswith(b"\xff\xd9"):
        return False
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    offset = 2
    saw_frame = False
    while offset < len(raw) - 2:
        if raw[offset] != 0xFF:
            return False
        while offset < len(raw) and raw[offset] == 0xFF:
            offset += 1
        if offset >= len(raw):
            return False
        marker = raw[offset]
        offset += 1
        if marker == 0xD9:
            return False
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(raw):
            return False
        segment_length = int.from_bytes(raw[offset : offset + 2], "big")
        segment_end = offset + segment_length
        if segment_length < 2 or segment_end > len(raw):
            return False
        if marker in sof_markers:
            if segment_length < 8:
                return False
            height = int.from_bytes(raw[offset + 3 : offset + 5], "big")
            width = int.from_bytes(raw[offset + 5 : offset + 7], "big")
            if not dimensions_are_safe(width, height):
                return False
            saw_frame = True
        if marker == 0xDA:
            return saw_frame and segment_end < len(raw) - 2
        offset = segment_end
    return False


def valid_gif_bytes(raw: bytes) -> bool:
    if len(raw) < 14 or raw[:6] not in {b"GIF87a", b"GIF89a"}:
        return False
    if not dimensions_are_safe(
        int.from_bytes(raw[6:8], "little"),
        int.from_bytes(raw[8:10], "little"),
    ):
        return False
    packed = raw[10]
    offset = 13 + (3 * (2 ** ((packed & 0x07) + 1)) if packed & 0x80 else 0)
    if offset > len(raw):
        return False

    def consume_sub_blocks(start: int) -> tuple[int, bool, bool]:
        cursor = start
        saw_data = False
        while cursor < len(raw):
            length = raw[cursor]
            cursor += 1
            if length == 0:
                return cursor, saw_data, True
            if cursor + length > len(raw):
                return cursor, saw_data, False
            saw_data = True
            cursor += length
        return cursor, saw_data, False

    saw_image = False
    while offset < len(raw):
        marker = raw[offset]
        offset += 1
        if marker == 0x3B:
            return saw_image and offset == len(raw)
        if marker == 0x21:
            if offset >= len(raw):
                return False
            offset, _, complete = consume_sub_blocks(offset + 1)
            if not complete:
                return False
            continue
        if marker != 0x2C or offset + 9 > len(raw):
            return False
        width = int.from_bytes(raw[offset + 4 : offset + 6], "little")
        height = int.from_bytes(raw[offset + 6 : offset + 8], "little")
        image_packed = raw[offset + 8]
        offset += 9
        if not dimensions_are_safe(width, height):
            return False
        if image_packed & 0x80:
            offset += 3 * (2 ** ((image_packed & 0x07) + 1))
        if offset >= len(raw) or not 2 <= raw[offset] <= 12:
            return False
        offset, saw_data, complete = consume_sub_blocks(offset + 1)
        if not complete or not saw_data:
            return False
        saw_image = True
    return False


def valid_webp_bytes(raw: bytes) -> bool:
    if (
        len(raw) < 20
        or raw[:4] != b"RIFF"
        or raw[8:12] != b"WEBP"
        or int.from_bytes(raw[4:8], "little") + 8 != len(raw)
    ):
        return False
    offset = 12
    saw_image = False
    canvas_dimensions: tuple[int, int] | None = None
    while offset + 8 <= len(raw):
        chunk_type = raw[offset : offset + 4]
        length = int.from_bytes(raw[offset + 4 : offset + 8], "little")
        data_start = offset + 8
        data_end = data_start + length
        if data_end > len(raw):
            return False
        if chunk_type == b"VP8X":
            if length < 10:
                return False
            canvas_dimensions = (
                1 + int.from_bytes(raw[data_start + 4 : data_start + 7], "little"),
                1 + int.from_bytes(raw[data_start + 7 : data_start + 10], "little"),
            )
            if not dimensions_are_safe(*canvas_dimensions):
                return False
        elif chunk_type == b"VP8 ":
            if length <= 10 or raw[data_start + 3 : data_start + 6] != b"\x9d\x01\x2a":
                return False
            dimensions = (
                int.from_bytes(raw[data_start + 6 : data_start + 8], "little") & 0x3FFF,
                int.from_bytes(raw[data_start + 8 : data_start + 10], "little") & 0x3FFF,
            )
            if not dimensions_are_safe(*dimensions):
                return False
            saw_image = True
        elif chunk_type == b"VP8L":
            if length <= 5 or raw[data_start] != 0x2F:
                return False
            packed = int.from_bytes(raw[data_start + 1 : data_start + 5], "little")
            dimensions = ((packed & 0x3FFF) + 1, ((packed >> 14) & 0x3FFF) + 1)
            if not dimensions_are_safe(*dimensions):
                return False
            saw_image = True
        offset = data_end + (length & 1)
    return saw_image and offset == len(raw) and (
        canvas_dimensions is None or dimensions_are_safe(*canvas_dimensions)
    )


def read_stable_validated_image_bytes(
    path: Path,
    max_bytes: int,
    validators: dict[str, Callable[[bytes], bool]],
) -> bytes | None:
    try:
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            if before.st_size <= 0 or before.st_size > max_bytes:
                return None
            raw = handle.read(max_bytes + 1)
            after_handle = os.fstat(handle.fileno())
        after_path = path.stat()
    except (FileNotFoundError, IsADirectoryError, OSError):
        return None
    stable_fields = ("st_size", "st_mtime_ns", "st_dev", "st_ino")
    if len(raw) != before.st_size or any(
        getattr(before, field, None) != getattr(after_handle, field, None)
        or getattr(before, field, None) != getattr(after_path, field, None)
        for field in stable_fields
    ):
        return None
    validator = validators.get(path.suffix.lower())
    return raw if validator is not None and validator(raw) else None
