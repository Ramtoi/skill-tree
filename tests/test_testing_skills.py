"""Guards for the repository-owned testing skills and the test map under `testing/`.

`testing/skills/*/SKILL.md` hold reviewed skill content. Runtime guidance invokes
the registered skt-testing skill; the audit skill remains repository-linked. They
live outside `skills/` on purpose: `starter_skills.discover_starter_skills` turns
every `skills/<name>/SKILL.md` into a Starter Pack built-in, and these two must
never become one. They still get the same lint the Starter Pack gets, because a
malformed frontmatter or a machine path is a defect wherever the skill lives.

`testing/test-map.yaml` is read by `testing/scripts/test_scope.py`; this file pins
its shape and the invariants selection relies on (every area path exists, every
journey name resolves to a spec, every cross-reader test exists).
"""

from __future__ import annotations

import fnmatch
import importlib.util
import re
from pathlib import Path
from typing import Optional

import pytest
import yaml

from skill_hub.domain.skills.skill_meta import parse_skill_frontmatter

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS = REPO_ROOT / "testing" / "skills"
MAP = REPO_ROOT / "testing" / "test-map.yaml"
AGENTS = REPO_ROOT / "AGENTS.md"

# The reviewed skills and the agent instructions are development internals:
# `.gitattributes` export-ignores them, so the public mirror has nothing here
# to check.
if not SKILLS.is_dir() or not AGENTS.is_file():
    pytest.skip(
        "testing/skills and AGENTS.md are private evidence not shipped in the public snapshot",
        allow_module_level=True,
    )

# Loaded directly (never `hub`), the same way tests/test_test_scope.py does,
# so the obligations-waiver guards below reuse the selector's OWN
# `subparser_paths` parser and import-graph builder instead of a second,
# possibly-drifting implementation.
_TEST_SCOPE_SPEC = importlib.util.spec_from_file_location(
    "test_scope_tool_for_testing_skills", REPO_ROOT / "testing" / "scripts" / "test_scope.py"
)
assert _TEST_SCOPE_SPEC and _TEST_SCOPE_SPEC.loader
test_scope_tool = importlib.util.module_from_spec(_TEST_SCOPE_SPEC)
_TEST_SCOPE_SPEC.loader.exec_module(test_scope_tool)

DESCRIPTION_MAX = 200
BODY_MAX_LINES = 500
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MACHINE_PATH_RE = re.compile(r"/Users/|/home/[a-z]|[A-Za-z]:\\")
LOCAL_LINK_RE = re.compile(r"\]\((?!https?://|#|mailto:)([^)\s]+)\)")
EXPECTED = {"skt-testing", "skt-test-audit"}


def _skill_dirs() -> list[Path]:
    return sorted(p for p in SKILLS.iterdir() if p.is_dir())


def test_the_two_skills_exist_and_are_not_starter_pack_entries():
    assert {p.name for p in _skill_dirs()} == EXPECTED
    for name in EXPECTED:
        assert not (REPO_ROOT / "skills" / name).exists(), f"{name} must not live under skills/ (Starter Pack)"


@pytest.mark.parametrize("skill_dir", _skill_dirs(), ids=lambda p: p.name)
def test_skill_frontmatter_and_body(skill_dir: Path):
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    meta = parse_skill_frontmatter(skill_dir / "SKILL.md")
    assert meta.get("name") == skill_dir.name, "frontmatter name must equal the directory name"
    assert NAME_RE.match(skill_dir.name)
    desc = str(meta.get("description") or "").strip()
    assert desc, "description is required"
    assert len(desc) <= DESCRIPTION_MAX, f"description is {len(desc)} chars; ceiling {DESCRIPTION_MAX}"
    body = text.split("---", 2)[2]
    assert len(body.splitlines()) <= BODY_MAX_LINES
    assert not MACHINE_PATH_RE.search(text), "no machine paths in a tracked skill"
    for target in LOCAL_LINK_RE.findall(text):
        assert (skill_dir / target).exists() or (REPO_ROOT / target).exists(), f"broken link {target}"


def test_instructions_use_registered_testing_skill():
    for path in (AGENTS, REPO_ROOT / "docs/agents/testing.md", SKILLS / "skt-test-audit/SKILL.md"):
        text = path.read_text(encoding="utf-8")
        assert "registered `skt-testing` skill" in text
        assert not any("skills/skt-testing/SKILL.md" in target for target in LOCAL_LINK_RE.findall(text))
    assert "testing/skills/skt-test-audit/SKILL.md" in AGENTS.read_text(encoding="utf-8")


def test_audit_template_has_every_required_section():
    template = (SKILLS / "skt-test-audit" / "assets" / "report-template.md").read_text(encoding="utf-8")
    for heading in (
        "Scope, baseline and selection rationale",
        "Reviewed and unaudited areas",
        "Behavior ownership and external contracts",
        "Findings",
        "Execution evidence",
        "Repair plan",
        "Reconciliation",
        "Remaining obligations",
    ):
        assert heading in template, f"template lacks section {heading!r}"


@pytest.fixture(scope="module")
def test_map() -> dict:
    return yaml.safe_load(MAP.read_text(encoding="utf-8"))


def _matches_any(pattern: str) -> bool:
    if any(ch in pattern for ch in "*?["):
        return any(True for _ in REPO_ROOT.glob(pattern))
    return (REPO_ROOT / pattern).exists()


def test_map_versions_and_runners(test_map: dict):
    assert isinstance(test_map["map_version"], int)
    assert test_map["map_version"] in test_map["compatible_map_versions"]
    assert isinstance(test_map["strategy_version"], int)
    assert set(test_map["runners"]) == {"python", "vitest", "e2e", "cargo", "integration"}
    for runner in test_map["runners"].values():
        assert "command" in runner and "ci_job" in runner


def test_map_python_groups_come_from_mutation_targets(test_map: dict):
    assert test_map["python"]["areas_from"] == "mutation/targets.yaml"
    for module, tests in test_map["python"]["overrides"].items():
        assert (REPO_ROOT / module).exists(), module
        for t in tests:
            assert (REPO_ROOT / t).exists(), t


def test_map_area_sources_and_journeys_resolve(test_map: dict):
    specs = {p.name for p in (REPO_ROOT / "app" / "e2e").glob("*.spec.ts")}
    for area, spec in test_map["app"]["areas"].items():
        for pattern in spec["sources"]:
            assert _matches_any(pattern), f"{area}: no file matches {pattern}"
        for journey in spec.get("journeys", []):
            candidates = {f"{journey}.journey.spec.ts", f"{journey}.spec.ts"}
            if "*" in journey:
                assert any(fnmatch.fnmatch(s, f"{journey}.journey.spec.ts") for s in specs), f"{area}: {journey}"
            else:
                assert candidates & specs, f"{area}: journey {journey} has no spec"


def test_map_every_journey_belongs_to_an_area(test_map: dict):
    specs = sorted(p.name for p in (REPO_ROOT / "app" / "e2e").glob("*.spec.ts"))
    owned: set[str] = set()
    for spec in test_map["app"]["areas"].values():
        for journey in spec.get("journeys", []):
            for s in specs:
                if fnmatch.fnmatch(s, f"{journey}.journey.spec.ts") or s == f"{journey}.spec.ts":
                    owned.add(s)
    unowned = sorted(set(specs) - owned)
    assert not unowned, f"journeys with no area (add them to testing/test-map.yaml): {unowned}"


def test_map_cross_readers_exist(test_map: dict):
    for entry in test_map["cross_readers"]:
        assert entry["runner"] in test_map["runners"], entry
        assert _matches_any(entry["path"]), entry["path"]
        assert entry["reads"], entry["path"]


def test_map_cross_readers_reader_text_contains_its_reads(test_map: dict):
    """A `cross_readers` entry with a non-glob `reads` path claims the
    reader's text actually opens that path. A glob entry (`tests/fixtures/
    ships_with/**`) is covered separately by selection rule 4 (any consumer
    whose text contains the fixture path); this only checks the literal
    paths, where a misattribution is silent until someone reads the file
    (TA-1-c903: eight entries named a reader that did not read what they
    claimed)."""
    for entry in test_map["cross_readers"]:
        reader_path = REPO_ROOT / entry["path"]
        if not reader_path.is_file():
            # A glob path (app/src/components/remotes/**, an area glob) has
            # no single file to read; skip, matches by different means.
            continue
        text = reader_path.read_text(encoding="utf-8", errors="ignore")
        for read in entry["reads"]:
            if any(ch in read for ch in "*?["):
                continue
            name = Path(read).name
            parents = [str(p) for p in Path(read).parents if str(p) != "."]
            candidates = [read, name, *parents]
            if read.endswith(".py"):
                # `python3 -c "import risks, permissions"` (execFileSync/
                # spawnSync inline scripts) names the module, never the
                # file — the .py suffix never appears in the reader's text.
                candidates.append(Path(read).stem)
            assert any(c in text for c in candidates), (
                f"{entry['path']} is listed as reading {read!r}, but its text "
                f"contains none of {candidates!r}"
            )


def test_map_shared_infrastructure_keys(test_map: dict):
    assert set(test_map["shared_infrastructure"]) == {"python", "vitest", "e2e", "cargo", "all"}


# --------------------------------------------- app.mock_owners (TA-1-4e14)

MOCKS_DIR = REPO_ROOT / "app" / "src" / "mocks"


def _all_mocks() -> list[str]:
    return sorted(f"app/src/mocks/{p.name}" for p in MOCKS_DIR.glob("*.ts"))


def test_map_has_no_mocks_wildcard(test_map: dict):
    shared = test_map["shared_infrastructure"]
    for runner in ("vitest", "e2e"):
        for entry in shared.get(runner) or []:
            assert entry != "app/src/mocks/**", (
                f"shared_infrastructure.{runner} still has the app/src/mocks/** wildcard "
                "(TA-1-4e14: list a shared mock by path, and attribute the rest in "
                "app.mock_owners)"
            )


def test_map_every_mock_is_owned_or_e2e_shared(test_map: dict):
    owners = (test_map.get("app") or {}).get("mock_owners") or {}
    e2e_shared = set(test_map["shared_infrastructure"]["e2e"])
    for mock in _all_mocks():
        assert mock in owners or mock in e2e_shared, (
            f"{mock} is neither in app.mock_owners nor shared_infrastructure.e2e: a direct "
            "change to it falls through to the unattributed-mock broaden fallback silently. "
            "Attribute it to the area(s) whose journeys reach it, or list it as e2e-shared "
            "if unsure."
        )


def test_map_mocks_imported_by_setup_or_aliased_are_vitest_shared(test_map: dict):
    setup_text = (REPO_ROOT / "app" / "src" / "test" / "setup.ts").read_text(encoding="utf-8")
    vitest_config_text = (REPO_ROOT / "app" / "vitest.config.ts").read_text(encoding="utf-8")
    stems = set(re.findall(r'"@/mocks/(\w+)"', setup_text))
    stems |= set(re.findall(r"mocks/(\w+)\.ts", vitest_config_text))
    vitest_shared = set(test_map["shared_infrastructure"]["vitest"])
    assert stems, "expected setup.ts to import at least one mock directly"
    for stem in sorted(stems):
        path = f"app/src/mocks/{stem}.ts"
        assert path in vitest_shared, (
            f"setup.ts or vitest.config.ts references {path} directly (invisible to the "
            "vitest import graph — a real test never imports the mock by path), but it is "
            "not in shared_infrastructure.vitest"
        )


def test_map_mock_owner_areas_exist_and_cover_importing_specs(test_map: dict):
    areas = (test_map.get("app") or {}).get("areas") or {}
    owners = (test_map.get("app") or {}).get("mock_owners") or {}
    e2e_dir = REPO_ROOT / "app" / "e2e"
    specs = {p.name for p in e2e_dir.glob("*.spec.ts")}
    for mock, mock_areas in owners.items():
        assert mock_areas, f"{mock}: empty owner-area list"
        for area in mock_areas:
            assert area in areas, f"{mock}: mock_owners names unknown area {area!r}"

        # Every e2e spec that names this mock (by module stem, the same text
        # scan test_scope.py's e2e_files_naming() does) must be reachable
        # from at least one of its owner areas' journeys — else a change to
        # the mock would select the owner areas' journeys, but never run the
        # very spec that actually imports the mock.
        needle = f"mocks/{Path(mock).stem}"
        naming_specs = {
            spec
            for spec in specs
            if needle in (e2e_dir / spec).read_text(encoding="utf-8", errors="ignore")
        }
        owned_specs: set[str] = set()
        for area in mock_areas:
            for journey in areas[area].get("journeys") or []:
                owned_specs |= {
                    s
                    for s in specs
                    if fnmatch.fnmatch(s, f"{journey}.journey.spec.ts") or s == f"{journey}.spec.ts"
                }
        uncovered = naming_specs - owned_specs
        assert not uncovered, (
            f"{mock}: e2e spec(s) naming it are not reachable from its owner area(s) "
            f"{mock_areas}'s journeys: {sorted(uncovered)}"
        )


_SCENE_FLAG_READ_RE = re.compile(r'scene(?:Flag|Value)\(\s*["\']([A-Za-z0-9_]+)["\']\s*[,)]')


def _area_for_spec(spec_name: str, areas: dict) -> Optional[str]:
    for area_name, area in areas.items():
        for journey in area.get("journeys") or []:
            if fnmatch.fnmatch(spec_name, f"{journey}.journey.spec.ts") or spec_name == f"{journey}.spec.ts":
                return area_name
    return None


def _flag_query_re(flag: str) -> re.Pattern[str]:
    return re.compile(r"[?&]" + re.escape(flag) + r"=")


def _flag_scene_helper_re(flag: str) -> re.Pattern[str]:
    # `scene(route, { projectOverview: true, ... })` (app/e2e/fixtures.ts) —
    # the flag never appears in a literal `?x=` query string here, only as
    # an object key inside the `scene(...)` call, so match that shape too.
    return re.compile(r"scene\([\s\S]*?\{[\s\S]*?\b" + re.escape(flag) + r"\b\s*:[\s\S]*?\}")


def test_map_mock_owners_cover_journeys_reached_through_scene_flags(test_map: dict):
    """`app.mock_owners` is attributed by reading a mock's CALLERS (which
    hook, which screen imports it) — but a mock's behavior usually branches
    on a scene flag/value read from `app/src/mocks/scenes.ts`
    (`sceneFlag("x")` / `sceneValue("x")`), and an e2e spec sets that flag
    through the URL query string (or `scene(route, { x: ... })`,
    `app/e2e/fixtures.ts`) independently of which area's hook happens to
    call the mock. A journey that drives a flag the mock reads, from an
    area the mock is not attributed to, would select nothing when the mock
    changes — the exact under-selection this map exists to prevent
    (TA-1-4e14 review, finding 1: `tauriUsageAnalytics.ts: [usage]` reads
    `projectOverview`/`noScan`, but `project-loadout-overview.journey.spec.ts`
    (area `project`) drives both with `?projectOverview=1`)."""
    owners = (test_map.get("app") or {}).get("mock_owners") or {}
    areas = (test_map.get("app") or {}).get("areas") or {}
    e2e_dir = REPO_ROOT / "app" / "e2e"
    specs = sorted(p for p in e2e_dir.glob("*.spec.ts"))
    spec_texts = {p.name: p.read_text(encoding="utf-8", errors="ignore") for p in specs}

    missing: list[str] = []
    for mock, mock_areas in owners.items():
        mock_path = REPO_ROOT / mock
        if not mock_path.is_file():
            continue
        text = mock_path.read_text(encoding="utf-8", errors="ignore")
        flags = sorted(set(_SCENE_FLAG_READ_RE.findall(text)))
        for flag in flags:
            query_re = _flag_query_re(flag)
            scene_re = _flag_scene_helper_re(flag)
            for spec_name, spec_text in spec_texts.items():
                if not (query_re.search(spec_text) or scene_re.search(spec_text)):
                    continue
                area = _area_for_spec(spec_name, areas)
                if area and area not in mock_areas:
                    missing.append(
                        f"{mock}: flag {flag!r} (spec {spec_name}) reaches area {area!r}, "
                        f"not in owners {mock_areas}"
                    )
    assert not missing, "\n".join(sorted(missing))


def test_map_mock_owners_cover_symbols_tauriCore_imports(test_map: dict):
    """Every symbol `tauriCore.ts` imports from a multi-area attributed mock
    needs a one-line comment on its `testing/test-map.yaml` entry explaining
    the extra reach — a single-area mock's reach is already self-evident
    from its one declared area."""
    tauri_core_text = (MOCKS_DIR / "tauriCore.ts").read_text(encoding="utf-8")
    imported_stems = set(re.findall(r'from\s+"\./(\w+)"', tauri_core_text))
    owners = (test_map.get("app") or {}).get("mock_owners") or {}
    map_lines = {
        line.split(":", 1)[0].strip(): line
        for line in MAP.read_text(encoding="utf-8").splitlines()
    }
    for mock, mock_areas in owners.items():
        stem = Path(mock).stem
        if stem not in imported_stems or len(mock_areas) <= 1:
            continue
        line = map_lines.get(mock)
        assert line is not None, f"{mock}: could not find its own line in {MAP}"
        assert "#" in line, (
            f"{mock}: tauriCore.ts imports from it and it is attributed to "
            f"{len(mock_areas)} areas {mock_areas}, but its test-map.yaml line has no "
            "comment explaining the extra reach"
        )


# --------------------------------------------------- obligations_waived (TA-1-obligations)


def test_map_obligation_waivers_are_well_formed(test_map: dict):
    """Every `obligations_waived` entry the `testing/test-map.yaml` comment
    promises is checked here: a known `kind`, a non-empty `reason` (an empty
    one is not a real waiver — `test_scope._find_waiver` now refuses to
    treat it as one either), a `path` that exists, and — for `argv_evidence`
    — a `subcommand` that `subparser_paths()` actually finds at that path
    today."""
    waivers = test_map.get("obligations_waived") or []
    for w in waivers:
        kind = w.get("kind")
        assert kind in {"vitest_importer", "argv_evidence"}, f"{w}: unknown waiver kind {kind!r}"
        reason = str(w.get("reason") or "").strip()
        assert reason, f"{w}: waiver has an empty reason"
        path = w.get("path")
        assert path, f"{w}: waiver is missing 'path'"
        full = REPO_ROOT / path
        assert full.is_file(), f"{w}: waiver path does not exist: {path}"
        if kind == "argv_evidence":
            subcommand = w.get("subcommand")
            assert subcommand, f"{w}: argv_evidence waiver is missing 'subcommand'"
            text = full.read_text(encoding="utf-8", errors="ignore")
            paths = test_scope_tool.subparser_paths(text)
            assert tuple(subcommand.split(" ")) in paths, (
                f"{w}: subcommand {subcommand!r} not found by subparser_paths() in {path}: "
                f"{sorted(paths)}"
            )


def test_map_obligation_waivers_are_not_stale(test_map: dict):
    """A `vitest_importer` waiver whose component now has a real direct
    vitest importer is stale: the obligation is met on its own, and keeping
    the waiver only hides that a real evidence-producing test exists. An
    `argv_evidence` waiver whose subcommand no longer exists (removed,
    renamed) is stale for the same reason. Built from the real repository's
    own import graph — the same evidence `compute_obligations` would use —
    not a second, possibly-drifting heuristic."""
    waivers = test_map.get("obligations_waived") or []
    if not waivers:
        return
    all_files = test_scope_tool.list_working_files(REPO_ROOT)
    targets = test_scope_tool.load_targets(REPO_ROOT)
    graphs = test_scope_tool.OwnershipGraphs(REPO_ROOT, test_map, targets, all_files)
    for w in waivers:
        path = w.get("path")
        if w.get("kind") == "vitest_importer":
            evidence = graphs.ts_reverse.get(path, set()) & graphs.vitest_test_files
            assert not evidence, (
                f"waiver for {path} is stale: {sorted(evidence)} now import it directly — "
                "remove the waiver"
            )
        elif w.get("kind") == "argv_evidence":
            full = REPO_ROOT / path
            text = full.read_text(encoding="utf-8", errors="ignore")
            paths = test_scope_tool.subparser_paths(text)
            subcommand = tuple((w.get("subcommand") or "").split(" "))
            assert subcommand in paths, (
                f"waiver names subcommand {w.get('subcommand')!r} for {path}, which "
                "subparser_paths() no longer finds there — remove the stale waiver"
            )
