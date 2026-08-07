from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def clean_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def valid_iso_timestamp(value: object) -> bool:
    text = clean_text(value)
    if not text:
        return False
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError:
        return False
    return parsed.tzinfo is not None


def load_json(path: Path, label: str, errors: list[str]) -> object | None:
    if not path.is_file():
        errors.append(f"缺少{label}：{path}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        errors.append(f"{label}不是有效 JSON：{path.name}（第 {exc.lineno} 行，第 {exc.colno} 列）")
    except OSError as exc:
        errors.append(f"无法读取{label}：{path}（{exc}）")
    return None
