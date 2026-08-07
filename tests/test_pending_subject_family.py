import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "engine" / "scripts" / "pipeline" / "sync_episode_analysis.py"
SPEC = importlib.util.spec_from_file_location("sync_episode_analysis_subject_family", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def empty_groups():
    return {category: [] for category in MODULE.CATEGORY_FILES}


def asset(name, *, asset_id=None, aliases=None, order=1):
    record = {
        "assetName": name,
        "aliases": list(aliases or []),
        "firstRequiredEpisode": 5,
        "firstRequiredOrder": order,
    }
    if asset_id is not None:
        record["assetId"] = asset_id
    return record


class PendingSubjectFamilyTests(unittest.TestCase):
    def defer(self, existing_records, incoming_records):
        existing = empty_groups()
        incoming = empty_groups()
        existing["characters"] = existing_records
        incoming["characters"] = incoming_records
        return MODULE.defer_identity_conflicts(existing, incoming, [], 6)

    def test_new_bare_name_is_deferred_when_explicit_forms_exist(self):
        accepted, pending, _counts = self.defer(
            [
                asset("赵德（宿舍便装形态）", asset_id="CHAR-001-EP5"),
                asset("赵德（崭新西装形态）", asset_id="CHAR-002-EP5", order=2),
            ],
            [asset("赵德")],
        )

        self.assertEqual(accepted["characters"], [])
        self.assertEqual(len(pending), 1)
        self.assertEqual(
            {item["assetId"] for item in pending[0]["conflicts"]},
            {"CHAR-001-EP5", "CHAR-002-EP5"},
        )

    def test_new_explicit_form_remains_automatic(self):
        accepted, pending, _counts = self.defer(
            [asset("赵德", asset_id="CHAR-001-EP5")],
            [asset("赵德（军训造型）")],
        )

        self.assertEqual([item["assetName"] for item in accepted["characters"]], ["赵德（军训造型）"])
        self.assertEqual(pending, [])

    def test_explicit_form_siblings_may_share_subject_alias(self):
        accepted, pending, _counts = self.defer(
            [asset("赵德（宿舍便装形态）", asset_id="CHAR-001-EP5", aliases=["赵德"])],
            [asset("赵德（崭新西装形态）", aliases=["赵德"])],
        )

        self.assertEqual(len(accepted["characters"]), 1)
        self.assertEqual(pending, [])

    def test_exact_bare_name_update_is_not_deferred_by_sibling_forms(self):
        accepted, pending, _counts = self.defer(
            [
                asset("赵德", asset_id="CHAR-001-EP5"),
                asset("赵德（军训造型）", asset_id="CHAR-002-EP5", order=2),
            ],
            [asset("赵德", asset_id="CHAR-001-EP5")],
        )

        self.assertEqual(len(accepted["characters"]), 1)
        self.assertEqual(pending, [])


if __name__ == "__main__":
    unittest.main()
