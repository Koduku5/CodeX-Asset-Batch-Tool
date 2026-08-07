import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "engine" / "scripts" / "pipeline" / "sync_episode_analysis.py"
SPEC = importlib.util.spec_from_file_location("sync_episode_analysis", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

VALIDATOR_SCRIPT = Path(__file__).resolve().parents[1] / "engine" / "scripts" / "pipeline" / "validate_asset_records.py"
VALIDATOR_SPEC = importlib.util.spec_from_file_location("validate_asset_records", VALIDATOR_SCRIPT)
VALIDATOR = importlib.util.module_from_spec(VALIDATOR_SPEC)
assert VALIDATOR_SPEC and VALIDATOR_SPEC.loader
sys.modules[VALIDATOR_SPEC.name] = VALIDATOR
VALIDATOR_SPEC.loader.exec_module(VALIDATOR)


def character(name, aliases, episode, order, asset_id=None):
    value = {
        "assetName": name,
        "productionNotes": None,
        "scriptSetting": "剧本明确设定。其余信息剧本未标明。",
        "inferenceBasis": None,
        "aliases": aliases,
        "firstRequiredEpisode": episode,
        "firstRequiredOrder": order,
        "faction": "测试组织｜测试部门（负责人）",
    }
    if asset_id:
        value["assetId"] = asset_id
    return value


class PendingAssetDeferralTests(unittest.TestCase):
    def test_conflicting_new_asset_is_deferred_with_full_draft(self):
        existing = {category: [] for category in MODULE.CATEGORY_FILES}
        incoming = {category: [] for category in MODULE.CATEGORY_FILES}
        existing["characters"] = [character("赵媛", ["赵总"], 8, 1, "CHAR-008-EP8")]
        incoming["characters"] = [character("《那时的我们》项目赵总", ["赵总"], 30, 1)]

        accepted, pending, counts = MODULE.defer_identity_conflicts(existing, incoming, [], 30)

        self.assertEqual([], accepted["characters"])
        self.assertEqual(1, counts["characters"])
        self.assertEqual("pending", pending[0]["status"])
        self.assertEqual([], pending[0]["assetIds"])
        self.assertEqual([], pending[0]["assetNames"])
        self.assertEqual(30, pending[0]["firstRequiredEpisode"])
        self.assertEqual(1, pending[0]["firstRequiredOrder"])
        self.assertNotIn("reservedAssetId", pending[0])
        self.assertEqual("赵总", pending[0]["draftAsset"]["aliases"][0])
        self.assertEqual("CHAR-008-EP8", pending[0]["conflicts"][0]["assetId"])

    def test_non_conflicting_asset_continues_normally(self):
        existing = {category: [] for category in MODULE.CATEGORY_FILES}
        incoming = {category: [] for category in MODULE.CATEGORY_FILES}
        incoming["characters"] = [character("新角色", [], 30, 1)]

        accepted, pending, counts = MODULE.defer_identity_conflicts(existing, incoming, [], 30)

        self.assertEqual("新角色", accepted["characters"][0]["assetName"])
        self.assertEqual([], pending)
        self.assertEqual(0, counts["characters"])

    def test_pending_order_does_not_consume_a_formal_id_during_analysis(self):
        existing = {category: [] for category in MODULE.CATEGORY_FILES}
        incoming = {category: [] for category in MODULE.CATEGORY_FILES}
        existing["characters"] = [character("赵媛", ["赵总"], 8, 1, "CHAR-008-EP8")]
        incoming["characters"] = [
            character("《那时的我们》项目赵总", ["赵总"], 30, 1),
            character("明确的新角色", [], 30, 2),
        ]

        accepted, pending, _ = MODULE.defer_identity_conflicts(existing, incoming, [], 30)
        MODULE.assign_asset_ids(existing, accepted)

        self.assertNotIn("reservedAssetId", pending[0])
        self.assertEqual("CHAR-009-EP30", accepted["characters"][0]["assetId"])

    def test_generated_pending_draft_passes_extended_validation(self):
        existing = {category: [] for category in MODULE.CATEGORY_FILES}
        incoming = {category: [] for category in MODULE.CATEGORY_FILES}
        existing["characters"] = [character("赵媛", ["赵总"], 8, 1, "CHAR-008-EP8")]
        incoming["characters"] = [character("《那时的我们》项目赵总", ["赵总"], 30, 1)]
        _, pending, _ = MODULE.defer_identity_conflicts(existing, incoming, [], 30)
        errors = []

        VALIDATOR.validate_pending_record(
            pending[0],
            1,
            {8, 30},
            {"CHAR-008-EP8": "赵媛"},
            {"赵媛"},
            {"赵媛": {"CHAR-008-EP8"}},
            errors,
        )

        self.assertEqual([], errors)


if __name__ == "__main__":
    unittest.main()
