from __future__ import annotations

import io
import os
import sys
import tempfile
import warnings
from pathlib import Path
from typing import Final, Sequence

from PIL import Image, ImageFile, ImageOps, UnidentifiedImageError


HARD_MAX_BYTES: Final = 20 * 1024 * 1024
HARD_MAX_PIXELS: Final = 24 * 1024 * 1024
SUPPORTED_SUFFIXES: Final = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".bmp": "BMP",
    ".webp": "WEBP",
}
SUPPORTED_FORMATS: Final = frozenset(SUPPORTED_SUFFIXES.values())


class NormalizationError(RuntimeError):
    """A clear, user-facing reference-image validation failure."""


def parse_positive_limit(raw: str, label: str, hard_limit: int) -> int:
    try:
        requested = int(raw, 10)
    except ValueError as error:
        raise NormalizationError(f"{label} 必须是正整数：{raw!r}") from error
    if requested <= 0:
        raise NormalizationError(f"{label} 必须大于 0：{requested}")
    return min(requested, hard_limit)


def read_bounded_source(source: Path, max_bytes: int) -> bytes:
    if not source.exists():
        raise NormalizationError(f"源图片不存在：{source}")
    if not source.is_file():
        raise NormalizationError(f"源路径不是文件：{source}")

    try:
        with source.open("rb") as stream:
            payload = stream.read(max_bytes + 1)
    except OSError as error:
        raise NormalizationError(f"无法读取源图片 {source}：{error}") from error

    if len(payload) > max_bytes:
        raise NormalizationError(
            f"源图片超过字节限制：允许最多 {max_bytes} 字节"
        )
    if not payload:
        raise NormalizationError("源图片为空")
    return payload


def inspect_image(payload: bytes, expected_format: str, max_pixels: int) -> tuple[int, int]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as image:
                actual_format = (image.format or "").upper()
                if actual_format not in SUPPORTED_FORMATS:
                    shown = actual_format or "未知"
                    raise NormalizationError(
                        f"图片实际格式不受支持：{shown}；仅支持 PNG/JPEG/BMP/WebP"
                    )
                if actual_format != expected_format:
                    raise NormalizationError(
                        "图片扩展名与实际内容不匹配："
                        f"扩展名表示 {expected_format}，实际为 {actual_format}"
                    )

                width, height = image.size
                if width <= 0 or height <= 0:
                    raise NormalizationError(
                        f"图片尺寸无效：{width}x{height}"
                    )
                pixel_count = width * height
                if pixel_count > max_pixels:
                    raise NormalizationError(
                        "图片超过像素限制："
                        f"{width}x{height}={pixel_count}，允许最多 {max_pixels} 像素"
                    )
                if getattr(image, "n_frames", 1) != 1:
                    raise NormalizationError("参考图片必须是单帧静态图片")

                # verify() walks the encoded structure without trusting a header-only probe.
                image.verify()
                return width, height
    except NormalizationError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise NormalizationError(
            f"图片像素尺寸超过安全限制（硬上限 {HARD_MAX_PIXELS} 像素）"
        ) from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise NormalizationError(f"图片结构无效或文件已损坏：{error}") from error


def decode_and_convert(
    payload: bytes,
    expected_format: str,
    expected_size: tuple[int, int],
) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as image:
                actual_format = (image.format or "").upper()
                if actual_format != expected_format or image.size != expected_size:
                    raise NormalizationError("图片在校验与解码之间出现不一致")

                # Pillow normally rejects truncated streams; set this explicitly so the
                # normalizer cannot inherit a permissive process-wide setting when imported.
                previous_truncated_setting = ImageFile.LOAD_TRUNCATED_IMAGES
                ImageFile.LOAD_TRUNCATED_IMAGES = False
                try:
                    image.load()
                finally:
                    ImageFile.LOAD_TRUNCATED_IMAGES = previous_truncated_setting

                transposed = ImageOps.exif_transpose(image)
                has_alpha = (
                    "A" in transposed.getbands()
                    or "transparency" in transposed.info
                )
                output_mode = "RGBA" if has_alpha else "RGB"
                normalized = transposed.convert(output_mode)
                # Do not carry EXIF, ICC, comments, or decoder-specific metadata into
                # the trusted PNG. The normalized pixels are the only output payload.
                normalized.info.clear()
                return normalized
    except NormalizationError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise NormalizationError(
            f"图片像素尺寸超过安全限制（硬上限 {HARD_MAX_PIXELS} 像素）"
        ) from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise NormalizationError(f"图片无法完整解码或文件已损坏：{error}") from error


def save_png_atomically(image: Image.Image, destination: Path) -> None:
    if destination.suffix.lower() != ".png":
        raise NormalizationError(f"目标文件必须使用 .png 扩展名：{destination}")

    parent = destination.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=parent,
        )
    except OSError as error:
        raise NormalizationError(f"无法准备目标目录 {parent}：{error}") from error

    temporary = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "wb") as stream:
            image.save(stream, format="PNG", compress_level=6)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except OSError as error:
        raise NormalizationError(f"无法原子写入目标 PNG {destination}：{error}") from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def normalize_reference_image(
    source: Path,
    destination: Path,
    max_bytes: int,
    max_pixels: int,
) -> None:
    suffix = source.suffix.lower()
    expected_format = SUPPORTED_SUFFIXES.get(suffix)
    if expected_format is None:
        shown = suffix or "<无扩展名>"
        raise NormalizationError(
            f"源图片扩展名不受支持：{shown}；仅支持 .png/.jpg/.jpeg/.bmp/.webp"
        )

    payload = read_bounded_source(source, max_bytes)
    image_size = inspect_image(payload, expected_format, max_pixels)
    normalized = decode_and_convert(payload, expected_format, image_size)
    try:
        save_png_atomically(normalized, destination)
    finally:
        normalized.close()


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 4:
        print(
            "用法：normalize_reference_image.py "
            "<source> <destination.png> <max_bytes> <max_pixels>",
            file=sys.stderr,
        )
        return 2

    source = Path(arguments[0])
    destination = Path(arguments[1])
    try:
        max_bytes = parse_positive_limit(arguments[2], "max_bytes", HARD_MAX_BYTES)
        max_pixels = parse_positive_limit(arguments[3], "max_pixels", HARD_MAX_PIXELS)
        normalize_reference_image(source, destination, max_bytes, max_pixels)
    except NormalizationError as error:
        print(f"[ERROR] 参考图片归一化失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:  # Defensive CLI boundary: never emit a traceback to users.
        print(f"[ERROR] 参考图片归一化失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
