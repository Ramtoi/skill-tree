"""Selector test for the REAL integration catalog (TA-1-d8cf, TA-1-29d6 context).

Every other catalog-area test builds a synthetic catalog in ``tmp_path``.
Nothing loads ``tests/integration_contracts/catalog.json`` itself the way the
validation runner does (``harness_validation.load_catalog()`` with no
arguments) and asserts what the `quick` and `offline` PR-gate profile
selectors actually pick. This pins that real selection so a catalog edit that
silently drops a case from a profile, or adds one back, is visible here
instead of only in a nightly nightly/offline run.
"""

from __future__ import annotations

from skill_hub.infrastructure.harnesses import harness_validation as hv

# The ten cases that carry `profiles: ["offline"]` alone (PR runs use the
# `quick` profile and never see them — see TA-1-29d6). Pinned by id so a
# profile change on any of these turns this test red.
OFFLINE_ONLY_CASE_IDS = {
    "docs.lifecycle",
    "hooks.feature-off",
    "invocation.opencode-command",
    "mcp.discovery",
    "permissions.lifecycle",
    "subagents.unsupported",
    "usage.claude",
    "usage.codex",
    "usage.source-retention",
    "usage.static-coverage",
}


def _case_ids(catalog, profile):
    return {str(c["id"]) for c in hv._select_cases(catalog, profile, [], [], [])}


def test_real_catalog_loads():
    catalog = hv.load_catalog()
    assert catalog["schema_version"] == hv.SCHEMA_VERSION
    assert catalog["cases"]


def test_quick_profile_selection_is_pinned():
    catalog = hv.load_catalog()
    quick_ids = _case_ids(catalog, "quick")
    assert quick_ids, "quick profile must select a non-empty set"
    assert quick_ids.isdisjoint(OFFLINE_ONLY_CASE_IDS)


def test_offline_profile_selection_is_pinned():
    catalog = hv.load_catalog()
    offline_ids = _case_ids(catalog, "offline")
    quick_ids = _case_ids(catalog, "quick")
    assert offline_ids, "offline profile must select a non-empty set"
    # offline is a strict superset of quick, and the gap is exactly the
    # pinned offline-only set.
    assert quick_ids <= offline_ids
    assert offline_ids - quick_ids == OFFLINE_ONLY_CASE_IDS
