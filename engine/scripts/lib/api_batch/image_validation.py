"""Bounded, thread-safe validation for generated and reference images."""

from __future__ import annotations

import os
import struct
import threading
import zlib
from pathlib import Path

from bounded_io import MAX_IMAGE_RESPONSE_BYTES
from image_structure import (
    read_stable_validated_image_bytes,
    valid_gif_bytes,
    valid_jpeg_bytes,
    valid_webp_bytes,
)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_VALIDATION_CACHE: dict[tuple[str, int, int], bool] = {}
_VALIDATION_MUTEX = threading.Lock()
_VALIDATION_SEMAPHORE = threading.BoundedSemaphore(2)


def _validate_png_bytes(raw: bytes) -> bool:
    try:
        if not raw.startswith(PNG_SIGNATURE):
            return False
        offset = len(PNG_SIGNATURE)
        saw_ihdr = False
        saw_idat = False
        idat_closed = False
        saw_plte = False
        idat_parts = []
        width = height = bit_depth = color_type = interlace = 0
        valid_depths = {
            0: {1, 2, 4, 8, 16},
            2: {8, 16},
            3: {1, 2, 4, 8},
            4: {8, 16},
            6: {8, 16},
        }
        while offset < len(raw):
            if offset + 12 > len(raw):
                return False
            length, chunk_type = struct.unpack_from(">I4s", raw, offset)
            data_start = offset + 8
            data_end = data_start + length
            chunk_end = data_end + 4
            if chunk_end > len(raw):
                return False
            chunk_data = raw[data_start:data_end]
            stored_crc = struct.unpack_from(">I", raw, data_end)[0]
            if not all(
                ord("A") <= value <= ord("Z") or ord("a") <= value <= ord("z")
                for value in chunk_type
            ) or not (ord("A") <= chunk_type[2] <= ord("Z")):
                return False
            if stored_crc != (zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF):
                return False
            if not saw_ihdr and chunk_type != b"IHDR":
                return False

            if chunk_type == b"IHDR":
                if saw_ihdr or length != 13:
                    return False
                (
                    width,
                    height,
                    bit_depth,
                    color_type,
                    compression,
                    filtering,
                    interlace,
                ) = struct.unpack(">IIBBBBB", chunk_data)
                if (
                    width <= 0
                    or height <= 0
                    or bit_depth not in valid_depths.get(color_type, set())
                    or compression != 0
                    or filtering != 0
                    or interlace not in {0, 1}
                ):
                    return False
                saw_ihdr = True
            elif chunk_type == b"PLTE":
                if saw_plte or saw_idat or length == 0 or length > 768 or length % 3:
                    return False
                if color_type in {0, 4}:
                    return False
                if color_type == 3 and length // 3 > 2**bit_depth:
                    return False
                saw_plte = True
            elif chunk_type == b"IDAT":
                if idat_closed or (color_type == 3 and not saw_plte):
                    return False
                saw_idat = True
                idat_parts.append(chunk_data)
            elif chunk_type == b"IEND":
                if length != 0 or not saw_idat or chunk_end != len(raw):
                    return False
                offset = chunk_end
                break
            elif not (chunk_type[0] & 0x20):
                return False
            if saw_idat and chunk_type != b"IDAT":
                idat_closed = True
            offset = chunk_end
        else:
            return False

        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
        bits_per_pixel = channels * bit_depth
        passes = [(0, 0, 1, 1)] if interlace == 0 else [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
        scanlines = []
        expected_size = 0
        for start_x, start_y, step_x, step_y in passes:
            pass_width = 0 if width <= start_x else (width - start_x + step_x - 1) // step_x
            pass_height = 0 if height <= start_y else (height - start_y + step_y - 1) // step_y
            if not pass_width or not pass_height:
                continue
            row_size = (pass_width * bits_per_pixel + 7) // 8
            scanlines.append((pass_height, row_size))
            expected_size += pass_height * (row_size + 1)
        if expected_size > 128 * 1024 * 1024:
            return False
        decompressor = zlib.decompressobj()
        decoded = decompressor.decompress(b"".join(idat_parts), expected_size + 1)
        if decompressor.unconsumed_tail or len(decoded) > expected_size:
            return False
        decoded += decompressor.flush(expected_size + 1 - len(decoded))
        if (
            len(decoded) != expected_size
            or not decompressor.eof
            or decompressor.unused_data
            or decompressor.unconsumed_tail
        ):
            return False
        decoded_offset = 0
        for pass_height, row_size in scanlines:
            for _ in range(pass_height):
                if decoded[decoded_offset] > 4:
                    return False
                decoded_offset += row_size + 1
        return decoded_offset == len(decoded)
    except (FileNotFoundError, IsADirectoryError, OSError, KeyError, struct.error, zlib.error):
        return False


def _validate_png_file(path: Path) -> bool:
    try:
        return _validate_png_bytes(path.read_bytes())
    except (FileNotFoundError, IsADirectoryError, OSError):
        return False


def valid_png(path: Path) -> bool:
    try:
        resolved = os.path.normcase(str(path.resolve()))
        stat = path.stat()
        if not path.is_file() or stat.st_size <= 0 or stat.st_size > MAX_IMAGE_RESPONSE_BYTES:
            return False
    except (FileNotFoundError, IsADirectoryError, OSError):
        return False
    cache_key = (resolved, stat.st_size, stat.st_mtime_ns)
    with _VALIDATION_MUTEX:
        cached = _VALIDATION_CACHE.get(cache_key)
    if cached is not None:
        return cached
    with _VALIDATION_SEMAPHORE:
        result = _validate_png_file(path)
    try:
        final_stat = path.stat()
    except (FileNotFoundError, IsADirectoryError, OSError):
        return False
    if (final_stat.st_size, final_stat.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        return False
    with _VALIDATION_MUTEX:
        stale_keys = [key for key in _VALIDATION_CACHE if key[0] == resolved]
        for stale_key in stale_keys:
            _VALIDATION_CACHE.pop(stale_key, None)
        _VALIDATION_CACHE[cache_key] = result
    return result


def read_stable_reference_bytes(path: Path) -> bytes | None:
    return read_stable_validated_image_bytes(
        path,
        20 * 1024 * 1024,
        {
            ".png": _validate_png_bytes,
            ".jpg": valid_jpeg_bytes,
            ".jpeg": valid_jpeg_bytes,
            ".gif": valid_gif_bytes,
            ".webp": valid_webp_bytes,
        },
    )


def valid_reference_image(path: Path) -> bool:
    return read_stable_reference_bytes(path) is not None
