import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "engine" / "scripts" / "pipeline" / "resolve_pending_asset.py"
SPEC = importlib.util.spec_from_file_location("resolve_pending_asset", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
import pipeline_protocol  # noqa: E402


def asset(name, episode, order, asset_id, aliases=None, setting=None):
    return {
        "assetId": asset_id,
        "assetName": name,
        "productionNotes": None,
        "scriptSetting": setting or f"{name}的剧本事实",
        "inferenceBasis": None,
        "aliases": list(aliases or []),
        "faction": "现代都市｜项目组",
        "firstRequiredEpisode": episode,
        "firstRequiredOrder": order,
    }


def without_id(record):
    return {key: value for key, value in record.items() if key != "assetId"}


class PendingAssetResolutionTests(unittest.TestCase):
    def make_cache(self):
        temporary = tempfile.TemporaryDirectory()
        cache = Path(temporary.name) / "cache"
        analyses = cache / "单集分析"
        analyses.mkdir(parents=True)
        base_assets = {category: [] for category in MODULE.CATEGORY_FILES}
        zhao = asset("赵媛", 8, 1, "CHAR-001-EP8", ["赵总"])
        later = asset("林助理", 30, 2, "CHAR-002-EP30")
        base_assets["characters"] = [zhao, later]
        for episode, records in ((8, [zhao]), (30, [later])):
            (analyses / f"第{episode:03d}集.json").write_text(
                json.dumps(
                    {
                        "source": "test.docx",
                        "episode": episode,
                        "scriptAnalysis": [],
                        "assets": {
                            **{category: [] for category in MODULE.CATEGORY_FILES},
                            "characters": [dict(record) for record in records],
                        },
                        "exclusions": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        return temporary, cache, base_assets

    def pending(self, decision, final_asset=None, target=None):
        value = {
            "pendingId": "PENDING-CHAR-0123456789abcdef",
            "episode": 30,
            "observedEpisodes": [30],
            "candidate": "《那时的我们》项目赵总",
            "proposedCategory": "characters",
            "firstRequiredEpisode": 30,
            "firstRequiredOrder": 1,
            "draftAsset": without_id(
                asset("《那时的我们》项目赵总", 30, 1, "CHAR-999-EP30", ["赵总"])
            ),
            "conflicts": [
                {
                    "category": "characters",
                    "assetId": "CHAR-001-EP8",
                    "assetName": "赵媛",
                    "sharedValue": "赵总",
                }
            ],
            "assetIds": [],
            "assetNames": [],
            "issue": "名称冲突",
            "impact": "需要人工确认",
            "status": "resolved",
            "decision": decision,
            "resolution": "人工已经核对",
            "resolvedAt": "2026-08-06T12:00:00+08:00",
        }
        if final_asset is not None:
            value["finalAsset"] = final_asset
        if target is not None:
            value["targetAssetId"] = target
        return value

    def test_independent_decision_inserts_by_source_order_and_remaps_later_id(self):
        temporary, cache, assets = self.make_cache()
        self.addCleanup(temporary.cleanup)
        final = without_id(asset("赵总（《那时的我们》项目）", 30, 1, "CHAR-999-EP30"))
        pending = [self.pending("independent", final)]

        values, result = MODULE.apply_staged_decisions(
            cache, assets, pending, {8, 30}, [8, 30]
        )

        characters = values[cache / "累计记录" / MODULE.CATEGORY_FILES["characters"]]
        self.assertEqual(
            ["CHAR-001-EP8", "CHAR-002-EP30", "CHAR-003-EP30"],
            [record["assetId"] for record in characters],
        )
        self.assertEqual("赵总（《那时的我们》项目）", characters[1]["assetName"])
        episode_30 = values[cache / "单集分析" / "第030集.json"]
        self.assertEqual(
            ["CHAR-003-EP30", "CHAR-002-EP30"],
            [record["assetId"] for record in episode_30["assets"]["characters"]],
        )
        self.assertEqual(["CHAR-002-EP30"], pending[0]["assetIds"])
        self.assertEqual(1, result["renumberedCount"])

    def test_exclusion_keeps_existing_formal_ids_and_adds_trace_to_episode(self):
        temporary, cache, assets = self.make_cache()
        self.addCleanup(temporary.cleanup)
        pending = [self.pending("exclude")]

        values, result = MODULE.apply_staged_decisions(
            cache, assets, pending, {8, 30}, [8, 30]
        )

        characters = values[cache / "累计记录" / MODULE.CATEGORY_FILES["characters"]]
        self.assertEqual(
            ["CHAR-001-EP8", "CHAR-002-EP30"],
            [record["assetId"] for record in characters],
        )
        episode_30 = values[cache / "单集分析" / "第030集.json"]
        self.assertEqual("《那时的我们》项目赵总", episode_30["exclusions"][0]["item"])
        self.assertEqual(0, result["renumberedCount"])

    def test_merge_uses_target_lineage_and_human_final_record(self):
        temporary, cache, assets = self.make_cache()
        self.addCleanup(temporary.cleanup)
        target = without_id(
            asset("赵媛", 8, 1, "CHAR-001-EP8", ["赵总"], "人工合并后的完整事实")
        )
        pending = [self.pending("merge", target, "CHAR-001-EP8")]

        values, _ = MODULE.apply_staged_decisions(
            cache, assets, pending, {8, 30}, [8, 30]
        )

        characters = values[cache / "累计记录" / MODULE.CATEGORY_FILES["characters"]]
        self.assertEqual("人工合并后的完整事实", characters[0]["scriptSetting"])
        episode_30 = values[cache / "单集分析" / "第030集.json"]
        merged = next(
            record
            for record in episode_30["assets"]["characters"]
            if record["assetId"] == "CHAR-001-EP8"
        )
        self.assertEqual("人工合并后的完整事实", merged["scriptSetting"])
        self.assertEqual(["CHAR-001-EP8"], pending[0]["assetIds"])

    def test_independent_decision_accepts_a_human_corrected_anchor(self):
        temporary, cache, assets = self.make_cache()
        self.addCleanup(temporary.cleanup)
        final = without_id(asset("赵总替身", 8, 2, "CHAR-999-EP8"))
        pending = [self.pending("independent", final)]

        values, _ = MODULE.apply_staged_decisions(
            cache, assets, pending, {8, 30}, [8, 30]
        )

        characters = values[cache / "累计记录" / MODULE.CATEGORY_FILES["characters"]]
        self.assertEqual(
            ["CHAR-001-EP8", "CHAR-002-EP8", "CHAR-003-EP30"],
            [record["assetId"] for record in characters],
        )
        self.assertEqual(["CHAR-002-EP8"], pending[0]["assetIds"])
        for episode in (8, 30):
            analysis = values[cache / "单集分析" / f"第{episode:03d}集.json"]
            self.assertIn(
                "CHAR-002-EP8",
                [record["assetId"] for record in analysis["assets"]["characters"]],
            )

    def test_merge_anchor_edit_renumbers_and_refreshes_every_episode_reference(self):
        temporary, cache, assets = self.make_cache()
        self.addCleanup(temporary.cleanup)
        target = without_id(
            asset("赵媛", 30, 1, "CHAR-001-EP30", ["赵总"], "核对剧本后的完整事实")
        )
        pending = [self.pending("merge", target, "CHAR-001-EP8")]

        values, _ = MODULE.apply_staged_decisions(
            cache, assets, pending, {8, 30}, [8, 30]
        )

        characters = values[cache / "累计记录" / MODULE.CATEGORY_FILES["characters"]]
        self.assertEqual(
            ["CHAR-001-EP30", "CHAR-002-EP30"],
            [record["assetId"] for record in characters],
        )
        for episode in (8, 30):
            analysis = values[cache / "单集分析" / f"第{episode:03d}集.json"]
            merged = next(
                record
                for record in analysis["assets"]["characters"]
                if record["assetId"] == "CHAR-001-EP30"
            )
            self.assertEqual(30, merged["firstRequiredEpisode"])
            self.assertEqual(1, merged["firstRequiredOrder"])
            self.assertEqual("核对剧本后的完整事实", merged["scriptSetting"])

    def test_multi_file_commit_rolls_every_target_back_after_injected_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            cache.mkdir()
            first = cache / "first.json"
            second = cache / "second.json"
            first.write_text('{"value":"before-first"}\n', encoding="utf-8")
            second.write_text('{"value":"before-second"}\n', encoding="utf-8")
            original = pipeline_protocol._replace_bytes_atomic
            commit_count = 0

            def fail_second_commit(target, value, label):
                nonlocal commit_count
                if label == "commit":
                    commit_count += 1
                    if commit_count == 2:
                        raise OSError("injected commit failure")
                return original(target, value, label)

            with patch.object(pipeline_protocol, "_replace_bytes_atomic", fail_second_commit):
                with self.assertRaises(OSError):
                    pipeline_protocol.transactional_commit_json(
                        cache,
                        "fault_injection",
                        {first: {"value": "after-first"}, second: {"value": "after-second"}},
                    )

            self.assertEqual({"value": "before-first"}, json.loads(first.read_text(encoding="utf-8")))
            self.assertEqual({"value": "before-second"}, json.loads(second.read_text(encoding="utf-8")))
            self.assertFalse((cache / ".pipeline.transaction.json").exists())
            self.assertFalse((cache / ".pipeline-transactions").exists())


if __name__ == "__main__":
    unittest.main()
