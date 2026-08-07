import json
import re
import sys
from pathlib import Path


CATEGORY_FILES = {
    "characters": "角色记录.json",
    "creatures": "生物记录.json",
    "extras": "群演记录.json",
    "scenes": "场景记录.json",
    "props": "道具记录.json",
}
SHAPE_SUFFIX_RE = re.compile(r"\s*[（(][^）)]*[）)]\s*$")


class UserError(Exception):
    pass


def clean_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def subject_name(asset_name: str) -> str:
    return SHAPE_SUFFIX_RE.sub("", asset_name).strip()


def read_records(path: Path) -> list[dict[str, object]]:
    if not path.is_file():
        raise UserError(f"缺少累计记录：{path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise UserError(f"{path.name} 不是有效 JSON（第 {exc.lineno} 行）") from None
    except OSError as exc:
        raise UserError(f"无法读取 {path.name}：{exc}") from None
    if not isinstance(value, list) or not all(isinstance(record, dict) for record in value):
        raise UserError(f"{path.name} 顶层必须是记录对象数组")
    return value


def load_records(root: Path) -> list[tuple[str, dict[str, object]]]:
    registry = root / "cache" / "累计记录"
    records: list[tuple[str, dict[str, object]]] = []
    for category, filename in CATEGORY_FILES.items():
        records.extend((category, record) for record in read_records(registry / filename))
    return records


def identity_keys(record: dict[str, object]) -> set[str]:
    name = clean_text(record.get("assetName"))
    aliases_value = record.get("aliases", [])
    aliases = aliases_value if isinstance(aliases_value, list) else []
    values = [name, subject_name(name), *(clean_text(value) for value in aliases)]
    return {normalize(value) for value in values if value}


def lightweight(category: str, record: dict[str, object]) -> dict[str, object]:
    aliases_value = record.get("aliases", [])
    aliases = (
        [clean_text(value) for value in aliases_value if clean_text(value)]
        if isinstance(aliases_value, list)
        else []
    )
    return {
        "category": category,
        "assetId": clean_text(record.get("assetId")),
        "assetName": clean_text(record.get("assetName")),
        "aliases": aliases,
    }


def run_index(records: list[tuple[str, dict[str, object]]]) -> dict[str, object]:
    category_order = {name: index for index, name in enumerate(CATEGORY_FILES)}
    items = [lightweight(category, record) for category, record in records]
    items.sort(
        key=lambda item: (
            category_order[str(item["category"])],
            str(item["assetName"]).casefold(),
        )
    )
    return {"ok": True, "mode": "index", "items": items}


def run_query(
    records: list[tuple[str, dict[str, object]]], candidates: list[str]
) -> dict[str, object]:
    candidate_keys = {candidate: normalize(candidate) for candidate in candidates}
    matches: list[dict[str, object]] = []
    for category, record in records:
        keys = identity_keys(record)
        matched_queries = [
            candidate for candidate, key in candidate_keys.items() if key in keys
        ]
        if not matched_queries:
            continue
        matches.append(
            {
                "category": category,
                "matchedQueries": matched_queries,
                "record": record,
            }
        )
    return {
        "ok": True,
        "mode": "query",
        "queries": candidates,
        "matches": matches,
    }


def main() -> None:
    if len(sys.argv) < 3:
        raise UserError(
            "用法：query_asset_records.py <skill-root> index | "
            "query <候选名称...>"
        )
    root = Path(sys.argv[1]).expanduser().resolve()
    if not root.is_dir():
        raise UserError(f"Skill 根目录不存在：{root}")
    mode = sys.argv[2].casefold()
    records = load_records(root)
    if mode == "index":
        if len(sys.argv) != 3:
            raise UserError("index 模式不接受候选名称")
        result = run_index(records)
    elif mode == "query":
        candidates = [clean_text(value) for value in sys.argv[3:]]
        if not candidates or any(not value for value in candidates):
            raise UserError("query 模式至少需要一个非空候选名称")
        candidates = list(dict.fromkeys(candidates))
        result = run_query(records, candidates)
    else:
        raise UserError("模式只能是 index 或 query")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except UserError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"错误：查询累计资产失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from None
