from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "engine" / "scripts" / "pipeline" / "asset_visual_specs.py"


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class AssetVisualSpecsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="ka-visual-specs-")
        self.root = Path(self.temp.name)
        (self.root / "scripts" / "pipeline").mkdir(parents=True)
        (self.root / "scripts" / "pipeline" / "extract_screenplay.py").write_text("# marker\n", encoding="utf-8")
        source = self.root / "剧本" / "测试剧本.txt"
        source.parent.mkdir(parents=True)
        source.write_text("测试剧本正文", encoding="utf-8")
        source_bytes = source.read_bytes()
        source_manifest = [{
            "name": source.name,
            "size": len(source_bytes),
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
        }]
        write_json(self.root / "cache" / "阅读进度.json", {
            "status": "complete",
            "sourceManifest": source_manifest,
            "discoveredEpisodes": [1],
            "completedEpisodes": [1],
            "currentEpisode": None,
        })
        world = {"records": [{
            "item": "青云宗｜服饰材料",
            "content": "青云宗常年位于寒冷山地，成员服装以厚织物、皮革与金属扣件构成。",
        }]}
        facts_fingerprint = canonical_sha256(world)
        write_json(self.root / "cache" / "累计记录" / "世界观记录.json", world)
        pagination = {
            "factsFingerprint": facts_fingerprint,
            "totalRecords": 1,
            "pageSize": 40,
            "coveredOffsets": [0],
            "nextOffset": None,
            "complete": True,
        }
        write_json(self.root / "cache" / "世界观分页进度.json", pagination)
        write_json(self.root / "cache" / "世界观总览.json", {
            "version": 2,
            "content": "青云宗位于寒冷山地，物资与工艺体系以厚织物、皮革和耐用金属连接件为主。",
            "factsFingerprint": facts_fingerprint,
            "coverageFingerprint": canonical_sha256(pagination),
            "finalizedAt": "2026-08-06T00:00:00Z",
        })
        write_json(self.root / "cache" / "待确认记录.json", [])
        write_json(self.root / "cache" / "累计记录" / "角色记录.json", [{
            "assetId": "CHAR-008-EP1",
            "assetName": "李掌门",
            "productionNotes": None,
            "faction": "青云宗｜掌门（宗门领袖）",
            "scriptSetting": "李掌门是青云宗掌门，长期在寒冷山地活动。其余信息剧本未标明。",
            "inferenceBasis": None,
            "aliases": ["掌门"],
            "firstRequiredEpisode": 1,
            "firstRequiredOrder": 1,
        }])
        for filename in ("生物记录.json", "群演记录.json", "场景记录.json", "道具记录.json"):
            write_json(self.root / "cache" / "累计记录" / filename, [])
        write_json(self.root / "cache" / "视觉规格回填进度.json", {
            "version": 1,
            "status": "not_started",
            "overviewFingerprint": None,
            "assetFactsFingerprint": None,
            "total": 0,
            "completedAssetIds": [],
            "current": None,
            "startedAt": None,
            "updatedAt": None,
            "completedAt": None,
        })

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_script(self, command: str, payload: object | None = None) -> dict[str, object]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root), command],
            input=None if payload is None else json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_one_asset_is_extracted_and_atomically_committed(self) -> None:
        started = self.run_script("start")
        self.assertEqual((started["completed"], started["total"], started["done"]), (0, 1, False))

        current = self.run_script("next")
        self.assertEqual(current["asset"]["assetId"], "CHAR-008-EP1")
        self.assertEqual(current["asset"]["category"], "characters")
        self.assertNotIn("productionNotes", current["asset"])
        self.assertNotIn("inferenceBasis", current["asset"])
        self.assertNotIn("assets", current)

        committed = self.run_script("commit", {
            "requestToken": current["requestToken"],
            "assetId": "CHAR-008-EP1",
            "productionNotes": "高挑稳重的人形长者，深色束发，穿厚织物内袍、暗青长外袍与皮革耐寒靴。",
            "inferenceBasis": "寒冷山地环境与宗门既定材料体系约束了服装层次、面料和连接结构。",
        })
        self.assertTrue(committed["done"])
        record = json.loads((self.root / "cache" / "累计记录" / "角色记录.json").read_text(encoding="utf-8"))[0]
        self.assertTrue(record["productionNotes"])
        self.assertTrue(record["inferenceBasis"])
        progress = json.loads((self.root / "cache" / "视觉规格回填进度.json").read_text(encoding="utf-8"))
        self.assertEqual(progress["status"], "complete")
        self.assertEqual(progress["completedAssetIds"], ["CHAR-008-EP1"])
        self.assertIsNone(progress["current"])
        self.assertTrue(self.run_script("next")["done"])

    def test_unresolved_pending_asset_blocks_visual_spec_start(self) -> None:
        write_json(self.root / "cache" / "待确认记录.json", [{
            "pendingId": "PENDING-CHAR-0123456789abcdef",
            "status": "pending",
            "draftAsset": {"assetName": "赵总"},
        }])
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root), "start"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("尚未完成人工确认与正式纳入", result.stderr)


if __name__ == "__main__":
    unittest.main()
