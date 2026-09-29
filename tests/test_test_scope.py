"""Synthetic-repository tests for `testing/scripts/test_scope.py`.

Every test drives the tool through `subprocess` against a throwaway git
repository under `tmp_path`, never `hub.py`, never pytest/vitest inside a
test. `--repo` is required by the tool's own CLI contract; the real
repository is used only by `test_select_on_real_repo_loads_the_map`.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL = REPO_ROOT / "testing" / "scripts" / "test_scope.py"

# The "real repo" tests run the selector against this checkout's own git
# history. The public snapshot is a bare `git archive` tree with no `.git`.
needs_repo_git = pytest.mark.skipif(
    not (REPO_ROOT / ".git").exists(),
    reason="not a git checkout (the public snapshot is a bare `git archive` tree)",
)

# Loaded directly (never `hub`) so fixtures can compute the exact same
# fingerprints/areas the tool itself would, instead of guessing at values
# a real `git ls-tree` walk would produce.
_spec = importlib.util.spec_from_file_location("test_scope_tool", TOOL)
assert _spec and _spec.loader
tool = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tool)

MINIMAL_TARGETS = """\
groups:
  groupa:
    why: test group a
    paths:
      - moda.py
  groupb:
    why: test group b
    paths:
      - modb.py
source_dirs: [skill_hub]
copy_dirs: []
ignore_tests: []
"""

MINIMAL_TEST_MAP = """\
map_version: 1
strategy_version: 1
runners:
  python:
    command: "python3 -m pytest {selectors} -q"
    static: ["ruff check .", "mypy"]
    ci_job: Python
    test_glob: "tests/test_*.py"
  vitest:
    command: "cd app && npx vitest run {files}"
    static: ["cd app && npx tsc --noEmit", "cd app && npm run lint"]
    ci_job: "Frontend tests"
    test_glob: "app/src/**/*.test.{ts,tsx}"
  e2e:
    command: "cd app && npx playwright test {files}"
    ci_job: "Browser journeys"
    test_glob: "app/e2e/*.spec.ts"
  cargo:
    command: "cd app/src-tauri && cargo test"
    ci_job: "Rust tests"
    sources: ["app/src-tauri/**"]
  integration:
    command: >-
      HOME={tmp} SKILL_HUB_HOME={tmp} PYTHONUSERBASE={tmp}
      python3 hub.py integration validate --case {cases} --report-dir {evidence}
    ci_job: "Offline contracts"
    catalog: "tests/integration_contracts/catalog.json"
python:
  areas_from: mutation/targets.yaml
  composition_tests: []
  overrides: {}
  closure_ceiling: 0.6
app:
  closure_ceiling: 0.6
  areas:
    shell:
      sources: ["app/src/App.tsx"]
      journeys: ["shell-journey"]
rust:
  sources: ["app/src-tauri/**"]
  runs_on: ["app/src-tauri/**"]
shared_infrastructure:
  python:
    - "tests/conftest.py"
    - "pyproject.toml"
    - "requirements.txt"
    - "testing/test-map.yaml"
    - "testing/scripts/**"
    - "mutation/targets.yaml"
  vitest: ["app/src/test/setup.ts", "app/vitest.config.ts", "app/package.json", "app/package-lock.json"]
  e2e: ["app/playwright.config.ts"]
  cargo: ["app/src-tauri/Cargo.toml", "app/src-tauri/Cargo.lock"]
  all: [".github/workflows/**", "scripts/ci-changed-areas.sh"]
cross_readers:
  - runner: vitest
    path: app/src/test/cliContract.test.ts
    reads: ["*.py"]
report_only: ["DESIGN-*/**", "**/*.md", "docs/**"]
"""

CATALOG = {
    "schema_version": 1,
    "cases": [
        {"id": "case.a", "selectors": ["tests/test_moda.py::test_a"], "profiles": ["quick"]},
        {"id": "case.b", "selectors": ["tests/test_modb.py::test_b"], "profiles": ["offline"]},
    ],
}


def run_git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def init_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.email", "test@example.com")
    run_git(repo, "config", "user.name", "Test")
    return repo


def write(repo: Path, rel: str, content: str) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def commit(repo: Path, message: str) -> str:
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", message)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


def base_repo(tmp_path: Path) -> Path:
    """A minimal repo with the map, targets, catalog and two modules."""
    repo = init_repo(tmp_path)
    write(repo, "mutation/targets.yaml", MINIMAL_TARGETS)
    write(repo, "testing/test-map.yaml", MINIMAL_TEST_MAP)
    write(repo, "tests/integration_contracts/catalog.json", json.dumps(CATALOG))
    write(repo, "moda.py", "def a():\n    return 1\n")
    write(repo, "modb.py", "def b():\n    return 2\n")
    write(repo, "tests/test_moda.py", "import moda\n\ndef test_a():\n    assert moda.a() == 1\n")
    write(repo, "tests/test_modb.py", "import modb\n\ndef test_b():\n    assert modb.b() == 2\n")
    write(repo, "tests/conftest.py", "# shared fixtures\n")
    write(repo, "app/src/App.tsx", "export const App = () => null;\n")
    write(
        repo,
        "app/src/App.test.tsx",
        "import { App } from './App';\n\ntest('renders', () => { App(); });\n",
    )
    write(repo, "app/e2e/shell.spec.ts", "test('shell', () => {});\n")
    write(repo, "app/playwright.config.ts", "export default {};\n")
    write(repo, "app/vitest.config.ts", "export default {};\n")
    write(repo, "app/package.json", "{}\n")
    write(repo, "requirements.txt", "pyyaml\n")
    write(repo, "pyproject.toml", "[tool.x]\n")
    commit(repo, "initial commit")
    return repo


def run_tool(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(TOOL), *args, "--repo", str(repo)],
        capture_output=True,
        text=True,
    )


def run_select(repo: Path, base: str = "HEAD", extra: Optional[List[str]] = None) -> Dict:
    args = ["select", "--base", base]
    if extra:
        args += extra
    proc = run_tool(repo, *args)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(proc.stdout)


def changed_paths(payload: Dict) -> List[str]:
    return [c["path"] for c in payload["changed"]]


# --------------------------------------------------------------- select


def test_added_source_selects_owning_python_tests(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "modc.py", "def c():\n    return 3\n")
    write(repo, "tests/test_modc.py", "import modc\n\ndef test_c():\n    assert modc.c() == 3\n")
    commit(repo, "add modc")

    payload = run_select(repo, base=base)
    assert "modc.py" in changed_paths(payload)
    assert "tests/test_modc.py" in payload["selections"]["python"]
    assert "tests/test_modb.py" not in payload["selections"]["python"]  # negative: unrelated
    assert payload["verdict"] == "ok"


def test_renamed_source_counts_as_change_to_both_paths(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    run_git(repo, "mv", "moda.py", "moda_renamed.py")
    commit(repo, "rename moda")

    payload = run_select(repo, base=base)
    paths = changed_paths(payload)
    assert "moda.py" in paths
    assert "moda_renamed.py" in paths


def test_working_inventory_uses_staged_paths_and_ignores_cache_files(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, ".gitignore", "__pycache__/\n")
    commit(repo, "ignore Python cache files")

    (repo / "skill_hub").mkdir()
    run_git(repo, "mv", "moda.py", "skill_hub/moda.py")
    write(repo, "skill_hub/new_module.py", "VALUE = 1\n")
    run_git(repo, "add", "skill_hub/new_module.py")
    write(repo, "skill_hub/untracked.py", "VALUE = 2\n")
    write(repo, "skill_hub/__pycache__/ignored.pyc", "cache\n")

    files = tool.list_working_files(repo)
    assert "skill_hub/moda.py" in files
    assert "skill_hub/new_module.py" in files
    assert "skill_hub/untracked.py" in files
    assert "moda.py" not in files
    assert "skill_hub/__pycache__/ignored.pyc" not in files

    changes = tool.collect_changes(repo, "HEAD", None, worktree=True)
    changed = {path for _status, old, new in changes for path in (old, new) if path}
    assert {"moda.py", "skill_hub/moda.py", "skill_hub/new_module.py", "skill_hub/untracked.py"} <= changed
    assert "skill_hub/__pycache__/ignored.pyc" not in changed


def test_deleted_source_is_recorded_as_a_change(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    (repo / "modb.py").unlink()
    commit(repo, "delete modb")

    payload = run_select(repo, base=base)
    entries = {c["path"]: c for c in payload["changed"]}
    assert "modb.py" in entries
    assert entries["modb.py"]["status"] == "D"


def test_added_test_selects_itself(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "tests/test_new_thing.py", "def test_new():\n    assert True\n")
    commit(repo, "add test")

    payload = run_select(repo, base=base)
    assert "tests/test_new_thing.py" in payload["selections"]["python"]


def test_renamed_test_counts_as_change_to_both_paths(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    run_git(repo, "mv", "tests/test_moda.py", "tests/test_moda_v2.py")
    commit(repo, "rename test")

    payload = run_select(repo, base=base)
    paths = changed_paths(payload)
    assert "tests/test_moda.py" in paths
    assert "tests/test_moda_v2.py" in paths


def test_deleted_test_is_listed_under_deleted_tests(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    (repo / "tests" / "test_moda.py").unlink()
    commit(repo, "delete test")

    payload = run_select(repo, base=base)
    assert "tests/test_moda.py" in payload["deleted_tests"]


def test_fixture_only_change_selects_readers(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/fixtures/thing.json", "{}\n")
    write(
        repo,
        "tests/test_uses_fixture.py",
        'PATH = "tests/fixtures/thing.json"\n\n\ndef test_reads():\n    assert PATH\n',
    )
    base = commit(repo, "add fixture and reader")

    write(repo, "tests/fixtures/thing.json", '{"changed": true}\n')
    commit(repo, "change fixture")

    payload = run_select(repo, base=base)
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["tests/fixtures/thing.json"]["kind"] == "fixture"
    assert "tests/test_uses_fixture.py" in payload["selections"]["python"]


def test_dependency_change_broadens_the_relevant_runner(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "requirements.txt", "pyyaml\nrequests\n")
    write(repo, "app/package-lock.json", "{}\n")
    commit(repo, "bump deps")

    payload = run_select(repo, base=base)
    assert payload["broaden"]["python"] is not None
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["requirements.txt"]["kind"] == "config"


def test_config_change_is_classified_and_broadens(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "pyproject.toml", "[tool.x]\nfoo = 1\n")
    write(repo, "app/vitest.config.ts", "export default { changed: true };\n")
    commit(repo, "config changes")

    payload = run_select(repo, base=base)
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["pyproject.toml"]["kind"] == "config"
    assert entries["app/vitest.config.ts"]["kind"] == "config"
    assert payload["broaden"]["python"] is not None
    assert payload["broaden"]["vitest"] is not None


def test_runner_change_is_classified_runner_and_broadens_e2e(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "app/playwright.config.ts", "export default { workers: 2 };\n")
    commit(repo, "playwright config change")

    payload = run_select(repo, base=base)
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["app/playwright.config.ts"]["kind"] == "runner"
    assert payload["broaden"]["e2e"] is not None


def test_e2e_helper_change_broadens_only_e2e(tmp_path):
    """A non-spec file under app/e2e/** (a helper, a shared fixture module)
    used to fall through classify_kind to "unknown" and broaden every
    runner, including python and cargo, which have no way to run it and
    no reason to rerun on an e2e-only change. It should broaden e2e alone.
    """
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "app/e2e/helpers.ts", "export const wait = () => {};\n")
    commit(repo, "add e2e helper")
    write(repo, "app/e2e/helpers.ts", "export const wait = () => Promise.resolve();\n")
    commit(repo, "change e2e helper")

    payload = run_select(repo, base=base)
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["app/e2e/helpers.ts"]["kind"] == "source"
    assert payload["broaden"]["e2e"] is not None
    assert payload["broaden"]["python"] is None
    assert payload["broaden"]["cargo"] is None


def test_test_support_file_does_not_fan_out_to_every_journey(tmp_path):
    """A support file under app/src/test/** (setup.ts, helpers.tsx, a
    fixture) owns no area by design. Treating "no area" the same as a
    genuinely unowned lib used to select every journey in every area — a
    single helpers.tsx edit in the real repo selected 81 of ~82 e2e specs.
    It should broaden vitest (already covered elsewhere) without touching
    e2e/journeys at all.
    """
    repo = base_repo(tmp_path)
    write(repo, "app/src/test/helpers.tsx", "export const noop = () => {};\n")
    commit(repo, "add test-support helper")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "app/src/test/helpers.tsx", "export const noop = () => undefined;\n")
    commit(repo, "change test-support helper")

    payload = run_select(repo, base=base)
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["app/src/test/helpers.tsx"]["kind"] == "source"
    assert entries["app/src/test/helpers.tsx"]["area"] is None
    assert payload["selections"]["e2e"] == []
    assert payload["journeys"] == []
    assert "app/src/test/helpers.tsx" not in payload["unknown_area"]


def test_unknown_path_broadens_every_runner(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "some_new_top_level_thing.txt", "mystery\n")
    commit(repo, "add unknown file")

    payload = run_select(repo, base=base)
    assert "some_new_top_level_thing.txt" in payload["unknown"]
    for runner in ("python", "vitest", "e2e", "cargo"):
        assert payload["broaden"][runner] is not None


def test_shared_infrastructure_change_broadens_all_runners(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, ".github/workflows/ci.yml", "name: ci\n")
    commit(repo, "touch workflow")

    payload = run_select(repo, base=base)
    for runner in ("python", "vitest", "e2e", "cargo"):
        assert payload["broaden"][runner] is not None


def test_empty_selection_is_needs_attention_not_a_pass(tmp_path):
    repo = base_repo(tmp_path)
    # A Python or TypeScript source change always selects at least the
    # cargo suite (F4) or every journey (unknown_area), so the genuinely
    # unselectable case is a fixture nothing reads: no consumer text
    # mentions its path or a parent directory of it, in any language.
    write(repo, "tests/fixtures/orphan.json", "{}\n")
    base = commit(repo, "add an orphan fixture with no consumers")

    write(repo, "tests/fixtures/orphan.json", '{"changed": true}\n')
    commit(repo, "change the orphan fixture")

    payload = run_select(repo, base=base)
    assert payload["verdict"] == "needs_attention"
    assert "empty_selection" in payload["reasons"]


def test_audit_report_on_real_repo_selects_nothing(tmp_path, monkeypatch):
    """An audit report is report-only even though a guard test reads other files under testing/."""
    import importlib.util

    if not (REPO_ROOT / ".git").exists():
        pytest.skip("not a git checkout (select(base='HEAD') needs the repo's own history)")

    tool = REPO_ROOT / "testing" / "scripts" / "test_scope.py"
    spec = importlib.util.spec_from_file_location("test_scope_real", tool)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    monkeypatch.setattr(
        mod,
        "collect_changes",
        lambda *a, **k: [("M", "testing/audits/2026-01-01-full/report.md", None)],
    )
    payload = mod.select(REPO_ROOT, base="HEAD", head=None, worktree=False)
    assert payload["report_only"] == ["testing/audits/2026-01-01-full/report.md"]
    assert payload["commands"] == []
    assert payload["unknown"] == []


def test_unowned_publish_script_stays_unknown_and_broadens_all(monkeypatch):
    """A path-only mention does not create a reader ownership edge."""
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("not a git checkout (select(base='HEAD') needs the repo's own history)")
    path = "scripts/preflight-publish.sh"
    test_map = tool.load_test_map(REPO_ROOT)
    assert tool.classify_kind(path, test_map) == "unknown"
    monkeypatch.setattr(tool, "collect_changes", lambda *a, **k: [("M", path, None)])

    payload = tool.select(REPO_ROOT, base="HEAD", head=None, worktree=False)

    assert path in payload["unknown"]
    assert all(payload["broaden"][runner] for runner in ("python", "vitest", "e2e", "cargo"))


def test_check_record_without_fingerprint_is_stale(tmp_path):
    import importlib.util

    tool = REPO_ROOT / "testing" / "scripts" / "test_scope.py"
    spec = importlib.util.spec_from_file_location("test_scope_real2", tool)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    verdict = mod.check_record(REPO_ROOT, {"inputs": {}, "commands": [], "results": {}})
    assert verdict["verdict"] == "stale"
    assert verdict["reason"] == "schema_changed"


@needs_repo_git
def test_select_on_real_repo_loads_the_map(tmp_path):
    # `--base HEAD` is an empty diff that works on a shallow CI checkout too;
    # it proves the real map, targets and catalog load and every runner key
    # is present.
    proc = subprocess.run(
        [sys.executable, str(TOOL), "select", "--base", "HEAD", "--head", "HEAD", "--repo", str(REPO_ROOT)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    for runner in ("python", "vitest", "e2e", "cargo", "integration"):
        assert runner in payload["selections"]
    assert payload["changed"] == []
    assert payload["verdict"] == "ok", payload


def test_broadened_runner_with_no_selected_files_still_gets_a_command(tmp_path):
    """A conftest-only change selects no particular test file but broadens
    python; the whole-suite command must still be emitted."""
    import importlib.util

    tool = REPO_ROOT / "testing" / "scripts" / "test_scope.py"
    spec = importlib.util.spec_from_file_location("test_scope_real3", tool)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    commands = mod.build_commands(
        mod.load_test_map(REPO_ROOT),
        {"python": set(), "vitest": set(), "e2e": set(), "cargo": False, "integration": set()},
        {"python": "shared_infrastructure.python: tests/conftest.py", "vitest": None, "e2e": None, "cargo": None},
    )
    assert [c["runner"] for c in commands] == ["python"]
    assert commands[0]["argv"] == ["python3", "-m", "pytest", "tests/", "-q"]


@needs_repo_git
def test_select_with_an_unresolvable_base_broadens_everything(tmp_path):
    # A shallow clone has no HEAD~1; a typo has no ref at all. Either way the
    # tool must not exit non-zero or select nothing: every runner broadens and
    # the record says why.
    proc = subprocess.run(
        [sys.executable, str(TOOL), "select", "--base", "no-such-ref-xyz", "--repo", str(REPO_ROOT)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["verdict"] == "needs_attention"
    assert "base_unresolvable" in payload["reasons"]
    assert all(v and v.startswith("base_unresolvable") for v in payload["broaden"].values()), payload["broaden"]
    assert payload["selections"]["cargo"] is True
    assert any(cmd["argv"][:3] == ["python3", "-m", "pytest"] for cmd in payload["commands"])


# ---------------------------------------------------------------- record


def test_record_refuses_zero_collected_as_a_pass(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "modc.py", "def c():\n    return 3\n")
    commit(repo, "add modc")
    payload = run_select(repo, base=base)
    selection_path = tmp_path / "selection.json"
    selection_path.write_text(json.dumps(payload))
    results_path = tmp_path / "results.json"
    results_path.write_text(json.dumps({"python": {"exit": 0, "collected": 0, "passed": 0}}))
    out_path = tmp_path / "record.json"

    proc = run_tool(
        repo,
        "record",
        "--from",
        str(selection_path),
        "--results",
        str(results_path),
        "-o",
        str(out_path),
    )
    assert proc.returncode == 0
    body = json.loads(proc.stdout)
    assert body["verdict"] == "error"
    assert not out_path.exists()


def test_record_and_check_record_roundtrip(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "modc.py", "def c():\n    return 3\n")
    write(repo, "tests/test_modc.py", "import modc\n\ndef test_c():\n    assert modc.c() == 3\n")
    commit(repo, "add modc")
    payload = run_select(repo, base=base)
    selection_path = tmp_path / "selection.json"
    selection_path.write_text(json.dumps(payload))
    results_path = tmp_path / "results.json"
    results_path.write_text(json.dumps({"python": {"exit": 0, "collected": 1, "passed": 1}}))
    out_path = tmp_path / "record.json"

    proc = run_tool(
        repo,
        "record",
        "--from",
        str(selection_path),
        "--results",
        str(results_path),
        "-o",
        str(out_path),
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert out_path.exists()

    fresh = run_tool(repo, "check-record", str(out_path))
    assert fresh.returncode == 0
    assert json.loads(fresh.stdout)["verdict"] == "fresh"

    write(repo, "modc.py", "def c():\n    return 999\n")
    commit(repo, "change modc after record")
    stale = run_tool(repo, "check-record", str(out_path))
    assert json.loads(stale.stdout)["verdict"] == "stale"
    assert "modc.py" in json.loads(stale.stdout)["changed"]


# ----------------------------------------------------------- audit-scope


def manifest_dir(repo: Path, name: str) -> Path:
    d = repo / "testing" / "audits" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_manifest(repo: Path, name: str, data: Dict) -> Path:
    d = manifest_dir(repo, name)
    path = d / "manifest.json"
    path.write_text(json.dumps(data))
    return path


def real_area_fingerprints(repo: Path, ref: str) -> Dict[str, Dict[str, object]]:
    """Real per-area fingerprints/paths for `repo` at `ref`, computed via
    the tool's own `build_areas_with_ownership`/`area_fingerprint` so
    fixtures never guess and never drift from what `validate` recomputes.
    """
    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    areas, area_extra = tool.build_areas_with_ownership(repo, test_map, targets)
    result = {}
    for area_name, globs in areas.items():
        fingerprint, paths = tool.area_fingerprint(repo, ref, globs, area_extra.get(area_name, set()))
        result[area_name] = {
            "status": "reviewed",
            "reviewed_fingerprint": fingerprint,
            "current_fingerprint": fingerprint,
            "path_count": len(paths),
            "paths": paths,
        }
    return result


def finding(fid: str, obligation: str, scenario: str, status: str, **overrides) -> Dict:
    data = {
        "id": fid,
        "origin_manifest": "self",
        "obligation": obligation,
        "layer": "domain",
        "scenario": scenario,
        "severity": "coverage",
        "status": status,
        "evidence": [],
    }
    data.update(overrides)
    return data


def complete_manifest(repo: Path, reviewed_revision: str, sequence: int = 1, predecessor=None, **overrides) -> Dict:
    data = {
        "schema_version": 1,
        "strategy_version": 1,
        "map_version": 1,
        "sequence": sequence,
        "predecessor": predecessor,
        "status": "complete",
        "scope": {
            "kind": "full",
            "requested": "full",
            "resolved_commit": reviewed_revision,
            "baseline": predecessor,
        },
        "reviewed_revision": reviewed_revision,
        "dirty": False,
        "history": "ancestor",
        "completed_at": "2026-01-01T00:00:00Z",
        "areas": real_area_fingerprints(repo, reviewed_revision),
        "execution_evidence": [],
        "findings": [],
        "gaps": [],
    }
    data.update(overrides)
    return data


def test_audit_scope_bootstrap_required_with_no_manifests(tmp_path):
    repo = base_repo(tmp_path)
    proc = run_tool(repo, "audit-scope", "--since-last")
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == {"verdict": "bootstrap_required"}


def test_audit_scope_version_bump_makes_baseline_ineligible(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write_manifest(repo, "2026-01-01-full", complete_manifest(repo, head, strategy_version=1))
    commit(repo, "add baseline manifest")

    # Bump strategy_version in the current map past the baseline's.
    bumped_map = MINIMAL_TEST_MAP.replace("strategy_version: 1", "strategy_version: 2")
    write(repo, "testing/test-map.yaml", bumped_map)
    commit(repo, "bump strategy version")

    proc = run_tool(repo, "audit-scope", "--since-last")
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == {"verdict": "bootstrap_required"}


def test_audit_scope_shallow_clone_is_content_only(tmp_path):
    origin = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=origin, capture_output=True, text=True, check=True
    ).stdout.strip()
    write_manifest(origin, "2026-01-01-full", complete_manifest(origin, head))
    commit(origin, "add baseline manifest")
    write(origin, "moda.py", "def a():\n    return 111\n")
    commit(origin, "change moda after baseline")

    shallow = tmp_path / "shallow"
    subprocess.run(
        ["git", "clone", "--depth", "1", "file://" + str(origin), str(shallow)],
        check=True,
        capture_output=True,
    )
    run_git(shallow, "config", "user.email", "test@example.com")
    run_git(shallow, "config", "user.name", "Test")

    proc = run_tool(shallow, "audit-scope", "--since-last")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["verdict"] == "ok"
    assert payload["history"] == "shallow"


def test_audit_scope_non_ancestor_squash_is_content_only_with_no_changed_areas(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write_manifest(repo, "2026-01-01-full", complete_manifest(repo, head))
    commit(repo, "add baseline manifest")

    # Rewrite history with a squash commit that preserves the same tree:
    # orphan branch, same working tree contents, one commit.
    run_git(repo, "checkout", "--orphan", "squashed")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "squash: same tree, new history")
    run_git(repo, "branch", "-D", "master")
    run_git(repo, "branch", "-m", "master")

    proc = run_tool(repo, "audit-scope", "--since-last")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["verdict"] == "ok"
    assert payload["history"] == "content_only"
    # The baseline is recorded repo-relative: an absolute machine path in a
    # committed manifest leaks the checkout and breaks the chain elsewhere.
    assert payload["baseline"] == "testing/audits/2026-01-01-full/manifest.json"
    for area_name, info in payload["areas"].items():
        assert info["status"] == "carried", (area_name, info)
        assert info.get("carried_from"), (area_name, info)


def test_audit_scope_narrow_areas_carries_unrelated_areas_forward(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write_manifest(repo, "2026-01-01-full", complete_manifest(repo, head))
    commit(repo, "add baseline manifest")
    write(repo, "moda.py", "def a():\n    return 42\n")
    commit(repo, "change moda")

    proc = run_tool(repo, "audit-scope", "--since-last", "--areas", "groupa")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["areas"]["groupa"]["status"] == "in_scope"
    assert payload["areas"]["groupb"]["status"] == "carried"
    assert payload["areas"]["groupb"].get("carried_from")


# ------------------------------------------------------------- manifest


def test_manifest_validate_accepts_open_fixed_superseded_reopened(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    manifest = complete_manifest(
        repo,
        head,
        findings=[
            finding("TA-1-a1a1", "owns X", "case one", "open"),
            finding("TA-1-b2b2", "owns Y", "case two", "fixed", fixed_revision="deadbeef"),
            finding("TA-1-c3c3", "replacement", "case five", "open"),
            finding("TA-1-d4d4", "owns Z", "case three", "superseded", superseded_by="TA-1-c3c3"),
            finding("TA-1-e5e5", "owns W", "case four", "reopened"),
        ],
    )
    path = write_manifest(repo, "2026-01-02-full", manifest)

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    results = json.loads(proc.stdout)
    assert results["verdict"] == "ok", results


def test_manifest_validate_rejects_malformed_json(tmp_path):
    repo = base_repo(tmp_path)
    path = repo / "testing" / "audits" / "bad" / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json")

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert isinstance(results, dict), results  # a single path is one object, never a list
    assert results["verdict"] == "invalid"
    assert results["reasons"]


def test_manifest_validate_with_several_paths_returns_a_list(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    good = write_manifest(repo, "good", complete_manifest(repo, head))
    bad_path = repo / "testing" / "audits" / "bad" / "manifest.json"
    bad_path.parent.mkdir(parents=True, exist_ok=True)
    bad_path.write_text("{not json")

    proc = run_tool(repo, "manifest", "validate", "--json", str(good), str(bad_path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert isinstance(results, list) and len(results) == 2, results
    verdicts = {r["path"]: r["verdict"] for r in results}
    assert verdicts[str(good)] == "ok"
    assert verdicts[str(bad_path)] == "invalid"


def test_manifest_validate_rejects_incomplete_manifest(tmp_path):
    repo = base_repo(tmp_path)
    path = write_manifest(repo, "incomplete", {"status": "complete"})

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "invalid"
    assert any("missing field" in r for r in results["reasons"])


def test_manifest_validate_rejects_a_missing_baseline_finding(tmp_path):
    """F8: reconciliation takes the union of predecessor findings; one
    missing from the new manifest fails validation (never a soft warning).
    """
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    baseline = complete_manifest(
        repo,
        head,
        sequence=1,
        findings=[
            finding("TA-1-f00d", "owns dropped thing", "dropped scenario", "open"),
        ],
    )
    baseline_path = write_manifest(repo, "2026-01-01-full", baseline)

    current = complete_manifest(
        repo,
        head,
        sequence=2,
        predecessor=str(baseline_path.relative_to(repo)),
        findings=[],
    )
    current_path = write_manifest(repo, "2026-02-01-incremental", current)

    proc = run_tool(repo, "manifest", "validate", "--json", str(current_path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "invalid"
    assert any("TA-1-f00d" in r for r in results["reasons"])


def test_manifest_validate_rewording_a_finding_keeps_its_id(tmp_path):
    """F8: obligation/layer/scenario are free text; the id is allocated at
    creation and does not change when they are reworded."""
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    baseline = complete_manifest(
        repo,
        head,
        sequence=1,
        findings=[
            finding("TA-1-aaaa", "original wording", "s", "open"),
        ],
    )
    baseline_path = write_manifest(repo, "2026-01-01-full", baseline)

    current = complete_manifest(
        repo,
        head,
        sequence=2,
        predecessor=str(baseline_path.relative_to(repo)),
        findings=[
            finding("TA-1-aaaa", "reworded text, same id", "s", "open"),
        ],
    )
    current_path = write_manifest(repo, "2026-02-01-incremental", current)

    proc = run_tool(repo, "manifest", "validate", "--json", str(current_path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "ok", results


def test_manifest_validate_rejects_forged_dirty_false(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    manifest = complete_manifest(repo, head, dirty=True, status="complete")
    path = write_manifest(repo, "forged", manifest)

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "invalid"
    assert any("dirty" in r for r in results["reasons"])


def test_manifest_validate_rejects_a_stale_reviewed_revision(tmp_path):
    repo = base_repo(tmp_path)
    manifest = complete_manifest(repo, "0" * 40)  # never a real commit
    path = write_manifest(repo, "stale", manifest)

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "invalid"
    assert any("does not resolve" in r for r in results["reasons"])


# ---------------------------------------------- baseline selection (F6)


def test_audit_scope_prefers_ancestor_over_higher_sequence_non_ancestor(tmp_path):
    repo = base_repo(tmp_path)
    head1 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    ancestor_manifest = complete_manifest(repo, head1, sequence=1)
    write_manifest(repo, "2026-01-01-ancestor", ancestor_manifest)
    commit(repo, "add ancestor baseline")
    head2 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    # A higher-sequence manifest that points at a commit NOT reachable from
    # HEAD (a foreign sha) must lose to the lower-sequence ancestor.
    _ = head2  # not used as the manifest's reviewed_revision on purpose
    foreign_manifest = complete_manifest(repo, "f" * 40, sequence=5)
    write_manifest(repo, "2026-03-01-foreign", foreign_manifest)
    commit(repo, "add non-ancestor baseline")

    proc = run_tool(repo, "audit-scope", "--since-last")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["reviewed_revision"] == head1


def test_audit_scope_future_map_version_is_ineligible(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    future_manifest = complete_manifest(repo, head, map_version=99)
    write_manifest(repo, "2026-01-01-future", future_manifest)
    commit(repo, "add future-versioned manifest")

    proc = run_tool(repo, "audit-scope", "--since-last")
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == {"verdict": "bootstrap_required"}


# --------------------------------------------------- facade / subprocess (F2)


def test_facade_reference_selects_the_owning_slice(tmp_path):
    """F2 facade index, and F3 (hub.py sink): hub.py imports TWO slices
    (thing, other). A change to thing's slice selects the test that
    reaches it via `hub.<symbol>`, but must NOT select other's dedicated
    test, which imports the `skill_hub.entrypoints.cli.other` module directly and never mentions
    `thing` — hub.py must not bridge unrelated slices' tests together."""
    repo = base_repo(tmp_path)
    write(repo, "skill_hub/entrypoints/cli/__init__.py", "")
    write(repo, "skill_hub/entrypoints/cli/thing.py", "NAME = \"thing\"\n\n\ndef do_thing():\n    return 1\n")
    write(repo, "skill_hub/entrypoints/cli/other.py", "NAME = \"other\"\n\n\ndef do_other():\n    return 1\n")
    write(
        repo,
        "hub.py",
        "from skill_hub.entrypoints.cli.thing import (  # noqa: F401\n    do_thing,\n)\n"
        "from skill_hub.entrypoints.cli.other import (  # noqa: F401\n    do_other,\n)\n",
    )
    targets_with_slices = MINIMAL_TARGETS.replace(
        "groups:\n",
        "groups:\n"
        "  cli_thing:\n    why: x\n    paths:\n      - skill_hub/entrypoints/cli/thing.py\n"
        "  cli_other:\n    why: x\n    paths:\n      - skill_hub/entrypoints/cli/other.py\n",
        1,
    )
    write(repo, "mutation/targets.yaml", targets_with_slices)
    write(
        repo,
        "tests/test_facade_user.py",
        "import hub\n\n\ndef test_via_facade():\n    assert hub.do_thing() == 1\n",
    )
    write(
        repo,
        "tests/test_other_direct.py",
        "import skill_hub.entrypoints.cli.other\n\n\ndef test_other_directly():\n"
        "    assert skill_hub.entrypoints.cli.other.do_other() == 1\n",
    )
    base = commit(repo, "add two facade slices and their tests")

    write(repo, "skill_hub/entrypoints/cli/thing.py", "NAME = \"thing\"\n\n\ndef do_thing():\n    return 2\n")
    commit(repo, "change the thing slice only")

    payload = run_select(repo, base=base)
    assert "tests/test_facade_user.py" in payload["selections"]["python"]
    assert "tests/test_other_direct.py" not in payload["selections"]["python"]  # negative


def test_subprocess_family_reference_selects_the_owning_slice(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "skill_hub/entrypoints/cli/__init__.py", "")
    write(repo, "skill_hub/entrypoints/cli/widget.py", "NAME = \"widget\"\n\n\ndef cmd_widget():\n    return 1\n")
    targets_with_slice = MINIMAL_TARGETS.replace(
        "groups:\n",
        "groups:\n  cli_widget:\n    why: x\n    paths:\n      - skill_hub/entrypoints/cli/widget.py\n",
        1,
    )
    write(repo, "mutation/targets.yaml", targets_with_slice)
    write(
        repo,
        "tests/test_widget_subprocess.py",
        "import subprocess, sys\n\n\ndef test_spawns_widget():\n"
        "    subprocess.run([sys.executable, 'hub.py', 'widget'])\n"
        "    # hub.py\n",
    )
    write(
        repo,
        "tests/test_pure_spawner.py",
        "import subprocess, sys\n\n\ndef test_spawns_something_unrecognizable():\n"
        "    subprocess.run([sys.executable, 'hub.py', 'zzz-not-a-command'])\n",
    )
    base = commit(repo, "add subprocess-family test and a pure spawner")

    write(repo, "skill_hub/entrypoints/cli/widget.py", "NAME = \"widget\"\n\n\ndef cmd_widget():\n    return 2\n")
    commit(repo, "change the widget slice")

    payload = run_select(repo, base=base)
    assert "tests/test_widget_subprocess.py" in payload["selections"]["python"]
    # The pure spawner has no recognizable subcommand word in its text, so
    # it is composition and runs on ANY python source change, not just
    # this one — assert it is present and labeled as such.
    assert "tests/test_pure_spawner.py" in payload["composition"]
    assert "tests/test_pure_spawner.py" in payload["selections"]["python"]


# ------------------------------------------------------- fixtures (F3)


def test_fixture_consumer_under_mocks_broadens_vitest_and_e2e(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/fixtures/usage/sample.json", "{}\n")
    write(
        repo,
        "app/src/mocks/tauriCore.ts",
        "export const FIXTURE = 'tests/fixtures/usage/sample.json';\n",
    )
    base = commit(repo, "add fixture and a mock that reads it")

    write(repo, "tests/fixtures/usage/sample.json", '{"changed": true}\n')
    commit(repo, "change fixture read by a mock")

    payload = run_select(repo, base=base)
    assert payload["broaden"]["vitest"] is not None
    assert payload["broaden"]["e2e"] is not None


def test_usage_fixture_json_import_selects_transitive_vitest_reader(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/fixtures/usage/inspection-session.json", '{"version": 1}\n')
    write(
        repo,
        "app/src/lib/fixtureReader.ts",
        'import session from "../../../tests/fixtures/usage/inspection-session.json";\n'
        "export const readSession = () => session;\n",
    )
    write(
        repo,
        "app/src/test/fixtureReader.test.ts",
        "import { readSession } from '../lib/fixtureReader';\n"
        "test('fixture', () => expect(readSession()).toBeTruthy());\n",
    )
    base = commit(repo, "add usage fixture reader")

    write(repo, "tests/fixtures/usage/inspection-session.json", '{"version": 2}\n')
    fixture_change = commit(repo, "change usage fixture")

    payload = run_select(repo, base=base, extra=["--head", fixture_change])
    assert "app/src/test/fixtureReader.test.ts" in payload["selections"]["vitest"]
    assert payload["broaden"]["vitest"] is None
    assert payload["uncertainty"] == []

    write(
        repo,
        "app/src/test/fixtureReader.test.ts",
        "import { readSession } from '../lib/fixtureReader';\n"
        "test('fixture changed', () => expect(readSession()).toBeTruthy());\n",
    )
    commit(repo, "change importing test")
    payload = run_select(repo, base=fixture_change)
    assert payload["selections"]["vitest"] == ["app/src/test/fixtureReader.test.ts"]
    assert payload["broaden"]["vitest"] is None
    assert payload["uncertainty"] == []


def test_fixture_consumer_under_src_tauri_sets_cargo(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/fixtures/agent_docs_corpus.json", "{}\n")
    write(
        repo,
        "app/src-tauri/src/commands/agent_docs.rs",
        '// reads tests/fixtures/agent_docs_corpus.json\n',
    )
    base = commit(repo, "add fixture and a rust reader")

    write(repo, "tests/fixtures/agent_docs_corpus.json", '{"changed": true}\n')
    commit(repo, "change fixture read by rust")

    payload = run_select(repo, base=base)
    assert payload["selections"]["cargo"] is True


# ------------------------------------------ per-area mock ownership (TA-1-4e14)

MOCK_OWNERS_APP_BLOCK = """\
app:
  closure_ceiling: 0.6
  mock_owners:
    app/src/mocks/widgetMock.ts: [widgetarea]
  areas:
    shell:
      sources: ["app/src/App.tsx"]
      journeys: ["shell-journey"]
    widgetarea:
      sources: ["app/src/widget/**"]
      journeys: ["widget-journey"]
"""

MOCK_OWNERS_TEST_MAP = MINIMAL_TEST_MAP.replace(
    "app:\n  closure_ceiling: 0.6\n  areas:\n    shell:\n"
    "      sources: [\"app/src/App.tsx\"]\n      journeys: [\"shell-journey\"]\n",
    MOCK_OWNERS_APP_BLOCK,
)


def _mock_owners_repo(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "testing/test-map.yaml", MOCK_OWNERS_TEST_MAP)
    write(repo, "app/src/mocks/widgetMock.ts", "export const WIDGET = 1;\n")
    write(repo, "app/e2e/widget-journey.journey.spec.ts", "test('widget', () => {});\n")
    return repo


def test_attributed_mock_selects_owner_area_journeys_not_every_runner(tmp_path):
    repo = _mock_owners_repo(tmp_path)
    base = commit(repo, "add an attributed mock and its owner area's journey spec")

    write(repo, "app/src/mocks/widgetMock.ts", "export const WIDGET = 2;\n")
    commit(repo, "change the attributed mock")

    payload = run_select(repo, base=base)
    assert "widget-journey" in payload["journeys"]
    assert "app/e2e/widget-journey.journey.spec.ts" in payload["selections"]["e2e"]
    # Narrowed, not broadened: the unrelated shell area's spec is absent and
    # neither runner is marked broadened.
    assert "app/e2e/shell.spec.ts" not in payload["selections"]["e2e"]
    assert payload["broaden"]["e2e"] is None
    assert payload["broaden"]["vitest"] is None


def test_attributed_mock_selects_e2e_specs_that_import_it(tmp_path):
    repo = _mock_owners_repo(tmp_path)
    # A spec outside the mock's own owner area(s) that still names the mock
    # by its module stem in its own text (e2e reaches a mock through the
    # running app, not an import, so this is a text scan).
    write(
        repo,
        "app/e2e/shell.spec.ts",
        "// scene fixture reads app/src/mocks/widgetMock.ts for this flow\n"
        "test('shell', () => {});\n",
    )
    base = commit(repo, "add an attributed mock and a spec naming it by text")

    write(repo, "app/src/mocks/widgetMock.ts", "export const WIDGET = 2;\n")
    commit(repo, "change the attributed mock")

    payload = run_select(repo, base=base)
    assert "app/e2e/shell.spec.ts" in payload["selections"]["e2e"]


def test_shared_mock_still_broadens_e2e(tmp_path):
    repo = _mock_owners_repo(tmp_path)
    map_with_shared_mock = MOCK_OWNERS_TEST_MAP.replace(
        '  e2e: ["app/playwright.config.ts"]',
        '  e2e: ["app/playwright.config.ts", "app/src/mocks/widgetMock.ts"]',
    )
    assert map_with_shared_mock != MOCK_OWNERS_TEST_MAP
    write(repo, "testing/test-map.yaml", map_with_shared_mock)
    base = commit(repo, "attribute the mock AND list it as e2e shared_infrastructure")

    write(repo, "app/src/mocks/widgetMock.ts", "export const WIDGET = 2;\n")
    commit(repo, "change the attributed-but-also-shared mock")

    payload = run_select(repo, base=base)
    # The owner-area narrowing still adds its journey…
    assert "widget-journey" in payload["journeys"]
    # …but shared_infrastructure.e2e wins: the runner is broadened, so the
    # unrelated shell spec is selected too (the whole e2e suite).
    assert payload["broaden"]["e2e"] is not None
    assert "app/e2e/shell.spec.ts" in payload["selections"]["e2e"]


def test_fixture_read_by_attributed_mock_selects_owner_area(tmp_path):
    repo = _mock_owners_repo(tmp_path)
    write(repo, "tests/fixtures/widget/sample.json", "{}\n")
    write(
        repo,
        "app/src/mocks/widgetMock.ts",
        "export const FIXTURE = 'tests/fixtures/widget/sample.json';\n",
    )
    base = commit(repo, "add a fixture read by an attributed mock")

    write(repo, "tests/fixtures/widget/sample.json", '{"changed": true}\n')
    commit(repo, "change the fixture")

    payload = run_select(repo, base=base)
    assert "widget-journey" in payload["journeys"]
    assert "app/e2e/widget-journey.journey.spec.ts" in payload["selections"]["e2e"]
    # An attributed mock's fixture consumer narrows instead of broadening
    # (contrast test_fixture_consumer_under_mocks_broadens_vitest_and_e2e,
    # which stays green for an UNattributed mock).
    assert payload["broaden"]["vitest"] is None
    assert payload["broaden"]["e2e"] is None


# ------------------------------------------------------------- cargo (F4)


def test_build_rs_rerun_input_triggers_cargo(tmp_path):
    repo = base_repo(tmp_path)
    map_with_build_rs = MINIMAL_TEST_MAP.replace(
        "rust:\n  sources:",
        "rust:\n  rerun_inputs_from: app/src-tauri/build.rs\n  sources:",
    )
    write(repo, "testing/test-map.yaml", map_with_build_rs)
    write(
        repo,
        "app/src-tauri/build.rs",
        'fn main() {\n    let modules = ["harnesses.py"];\n'
        '    println!("cargo:rerun-if-changed={}", "harnesses.py");\n}\n',
    )
    write(repo, "harnesses.py", "def probe():\n    return 1\n")
    base = commit(repo, "add build.rs listing harnesses.py as a rerun input")

    write(repo, "harnesses.py", "def probe():\n    return 2\n")
    commit(repo, "change harnesses.py")

    payload = run_select(repo, base=base)
    assert payload["selections"]["cargo"] is True


# --------------------------------------------------- record fingerprint (F5)


def _make_recorded(repo, tmp_path, base):
    payload = run_select(repo, base=base)
    selection_path = tmp_path / "selection.json"
    selection_path.write_text(json.dumps(payload))
    results_path = tmp_path / "results.json"
    results_path.write_text(json.dumps({"python": {"exit": 0, "collected": 1, "passed": 1}}))
    out_path = tmp_path / "record.json"
    proc = run_tool(
        repo, "record", "--from", str(selection_path), "--results", str(results_path), "-o", str(out_path)
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out_path


def _repo_with_recorded_modc(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "modc.py", "def c():\n    return 3\n")
    write(repo, "tests/test_modc.py", "import modc\n\ndef test_c():\n    assert modc.c() == 3\n")
    commit(repo, "add modc")
    out_path = _make_recorded(repo, tmp_path, base)
    return repo, out_path


def test_check_record_is_stale_when_the_map_file_changes(tmp_path):
    repo, out_path = _repo_with_recorded_modc(tmp_path)

    write(repo, "testing/test-map.yaml", MINIMAL_TEST_MAP + "\n# touched\n")
    result = run_tool(repo, "check-record", str(out_path))
    body = json.loads(result.stdout)
    assert body["verdict"] == "stale"
    assert "testing/test-map.yaml" in body["changed"]


def test_check_record_is_stale_when_targets_file_changes(tmp_path):
    repo, out_path = _repo_with_recorded_modc(tmp_path)

    write(repo, "mutation/targets.yaml", MINIMAL_TARGETS + "\n# touched\n")
    result = run_tool(repo, "check-record", str(out_path))
    body = json.loads(result.stdout)
    assert body["verdict"] == "stale"
    assert "mutation/targets.yaml" in body["changed"]


def test_check_record_is_stale_on_dirty_content_in_a_selected_file(tmp_path):
    repo, out_path = _repo_with_recorded_modc(tmp_path)

    # Dirty, uncommitted edit to a selected test file.
    write(repo, "tests/test_modc.py", "import modc\n\ndef test_c():\n    assert modc.c() == 999\n")
    result = run_tool(repo, "check-record", str(out_path))
    body = json.loads(result.stdout)
    assert body["verdict"] == "stale"
    assert "tests/test_modc.py" in body["changed"]


def test_record_uses_whole_semantic_identity_but_excludes_inert_docs(tmp_path):
    repo, out_path = _repo_with_recorded_modc(tmp_path)

    write(repo, "docs/note.md", "inert documentation\n")
    fresh = json.loads(run_tool(repo, "check-record", str(out_path)).stdout)
    assert fresh["verdict"] == "fresh", fresh

    write(repo, "new_transitive_input.py", "VALUE = 1\n")
    stale = json.loads(run_tool(repo, "check-record", str(out_path)).stdout)
    assert stale["verdict"] == "stale"
    assert stale["reason"] == "semantic_inputs_changed"


def test_record_stays_fresh_when_original_diff_inert_doc_changes_again(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "moda.py", "VALUE = 2\n")
    write(repo, "docs/change.md", "first draft\n")
    payload = run_select(repo, base="HEAD", extra=["--worktree"])
    selection_path = tmp_path / "selection-inert.json"
    selection_path.write_text(json.dumps(payload))
    results = {
        command["runner"]: {"exit": 0, "collected": 1, "passed": 1}
        for command in payload["commands"]
    }
    results_path = tmp_path / "results-inert.json"
    results_path.write_text(json.dumps(results))
    record_path = tmp_path / "record-inert.json"
    made = run_tool(
        repo,
        "record",
        "--from",
        str(selection_path),
        "--results",
        str(results_path),
        "-o",
        str(record_path),
    )
    assert json.loads(made.stdout)["verdict"] == "ok"

    write(repo, "docs/change.md", "second draft\n")
    checked = json.loads(run_tool(repo, "check-record", str(record_path)).stdout)
    assert checked["verdict"] == "fresh", checked


# --------------------------------------------------- F7: manifest recompute


def _minimal_offline_report() -> Dict:
    """The smallest report `harness_validation.read_report` accepts and
    certifies as an evidence pass: one offline case, fresh via
    `finished_at`, zero coverage gaps."""
    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    statuses = ("pass", "fail", "blocked", "unsupported", "inconclusive", "skipped")
    return {
        "schema_version": 1,
        "run_id": "run-1",
        "status": "complete",
        "profile": "offline",
        "metadata": {"corpus_sha256": "a" * 64, "provenance": {"status": "not_collected"}},
        "finished_at": now,
        "cases": [
            {
                "id": "case-1",
                "status": "pass",
                "reason": "ok",
                "elapsed_seconds": 0.1,
                "required_evidence": ["offline_pytest"],
                "revision": "r1",
                "layer": "offline",
                "environment_family": "linux:x:python3.11",
                "pytest": {"collected": 1, "passed": 1, "failed": 0, "errors": 0, "skipped": 0, "xfailed": 0},
            }
        ],
        "coverage_gaps": [],
        "summary": {s: (1 if s == "pass" else 0) for s in statuses},
    }


def _read_via_harness_validation(report_path: Path) -> Dict:
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location(
        "harness_validation",
        REPO_ROOT / "skill_hub" / "infrastructure" / "harnesses" / "harness_validation.py",
    )
    module = _ilu.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_report(report_path)


def test_manifest_validate_rejects_forged_area_paths(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    manifest = complete_manifest(repo, head)
    # Forge groupa's paths: claim a file the tree does not have.
    manifest["areas"]["groupa"]["paths"] = {"moda.py": "x", "phantom.py": "y"}
    path = write_manifest(repo, "forged-paths", manifest)

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "invalid"
    assert any("paths do not match" in r for r in results["reasons"])


def test_manifest_validate_reverifies_a_matching_integration_report(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    report_dir = repo / "testing" / "audits" / "good" / "evidence"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "report.json"
    report_path.write_text(json.dumps(_minimal_offline_report()))
    read = _read_via_harness_validation(report_path)

    manifest = complete_manifest(
        repo,
        head,
        execution_evidence=[
            {
                "runner": "integration",
                "report": "testing/audits/good/evidence/report.json",
                "report_sha256": "irrelevant",
                "run_id": "run-1",
                "captured_verdict": read["evidence_verdict"],
                "effective_verdict": read["effective_evidence_verdict"],
                "missing_requirements": read["missing_requirements"],
                    "effective_missing_requirements": read["effective_missing_requirements"],
                "freshness": read["freshness"],
                "compared_to": None,
                "self_reported": False,
            }
        ],
    )
    path = write_manifest(repo, "good", manifest)

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    results = json.loads(proc.stdout)
    assert results["verdict"] == "ok", results


def test_manifest_validate_rejects_a_tampered_integration_report(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    report_dir = repo / "testing" / "audits" / "tampered" / "evidence"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "report.json"
    report_path.write_text(json.dumps(_minimal_offline_report()))
    read = _read_via_harness_validation(report_path)

    manifest = complete_manifest(
        repo,
        head,
        execution_evidence=[
            {
                "runner": "integration",
                "report": "testing/audits/tampered/evidence/report.json",
                "report_sha256": "irrelevant",
                "run_id": "run-1",
                "captured_verdict": read["evidence_verdict"],
                "effective_verdict": read["effective_evidence_verdict"],
                "missing_requirements": read["missing_requirements"],
                    "effective_missing_requirements": read["effective_missing_requirements"],
                "freshness": read["freshness"],
                "compared_to": None,
                "self_reported": False,
            }
        ],
    )
    path = write_manifest(repo, "tampered", manifest)

    # Tamper with the report AFTER the manifest recorded its verdict: the
    # case that made it "pass" now fails, but the manifest still claims
    # the old, stale verdict.
    tampered_report = _minimal_offline_report()
    tampered_report["cases"][0]["status"] = "fail"
    tampered_report["summary"] = {"pass": 0, "fail": 1, "blocked": 0, "unsupported": 0, "inconclusive": 0, "skipped": 0}
    report_path.write_text(json.dumps(tampered_report))

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "invalid"
    assert any("is stale" in r for r in results["reasons"])


def test_manifest_validate_trusts_a_self_reported_integration_entry(tmp_path):
    """A self_reported entry is never re-read, even if the report on disk
    would now disagree with it."""
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    report_dir = repo / "testing" / "audits" / "trusted" / "evidence"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "report.json"
    report_path.write_text(json.dumps(_minimal_offline_report()))

    manifest = complete_manifest(
        repo,
        head,
        execution_evidence=[
            {
                "runner": "integration",
                "report": "testing/audits/trusted/evidence/report.json",
                "captured_verdict": "pass",
                "effective_verdict": "pass",
                "missing_requirements": [],
                "freshness": {"status": "fresh"},
                "self_reported": True,
            }
        ],
    )
    path = write_manifest(repo, "trusted", manifest)

    proc = run_tool(repo, "manifest", "validate", "--json", str(path))
    assert proc.returncode == 0
    results = json.loads(proc.stdout)
    assert results["verdict"] == "ok", results


# --------------------------------------------- F8: full-chain reconciliation


def test_reconciliation_walks_the_full_predecessor_chain(tmp_path):
    """A finding open in the oldest manifest, fixed in the middle one, need
    not reappear in the newest; one still open must."""
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    manifest_a = complete_manifest(
        repo,
        head,
        sequence=1,
        findings=[
            finding("TA-1-1111", "fixed later", "s1", "open"),
            finding("TA-1-2222", "stays open", "s2", "open"),
        ],
    )
    path_a = write_manifest(repo, "a-oldest", manifest_a)

    manifest_b = complete_manifest(
        repo,
        head,
        sequence=2,
        predecessor=str(path_a.relative_to(repo)),
        findings=[
            finding("TA-1-1111", "fixed later", "s1", "fixed", fixed_revision="deadbeef"),
            finding("TA-1-2222", "stays open", "s2", "open"),
        ],
    )
    path_b = write_manifest(repo, "b-middle", manifest_b)

    # The newest manifest drops the now-fixed finding (allowed) but must
    # still carry the one that has stayed open the whole chain.
    manifest_c_missing = complete_manifest(
        repo, head, sequence=3, predecessor=str(path_b.relative_to(repo)), findings=[]
    )
    path_c_bad = write_manifest(repo, "c-newest-bad", manifest_c_missing)
    bad = json.loads(run_tool(repo, "manifest", "validate", "--json", str(path_c_bad)).stdout)
    assert bad["verdict"] == "invalid"
    assert any("TA-1-2222" in r for r in bad["reasons"])
    assert not any("TA-1-1111" in r for r in bad["reasons"])

    manifest_c_good = complete_manifest(
        repo,
        head,
        sequence=3,
        predecessor=str(path_b.relative_to(repo)),
        findings=[finding("TA-1-2222", "stays open", "s2", "open")],
    )
    path_c_good = write_manifest(repo, "c-newest-good", manifest_c_good)
    good = json.loads(run_tool(repo, "manifest", "validate", "--json", str(path_c_good)).stdout)
    assert good["verdict"] == "ok", good


# ------------------------------------------------------- --since (F6/F7)


def test_since_date_returns_the_same_payload_shape_as_since_last(tmp_path):
    repo = base_repo(tmp_path)
    import datetime as _dt
    import os as _os

    initial_commit_time = subprocess.run(
        ["git", "log", "-1", "--format=%cI"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    initial = _dt.datetime.fromisoformat(initial_commit_time)
    # Force the second commit's date a full day after the first, real one,
    # so a --before timestamp strictly between them is unambiguous no
    # matter how fast the test actually runs.
    second_commit_time = (initial + _dt.timedelta(days=1)).isoformat()
    since_time = (initial + _dt.timedelta(hours=1)).isoformat()

    write(repo, "moda.py", "def a():\n    return 42\n")
    run_git(repo, "add", "-A")
    env = dict(_os.environ, GIT_AUTHOR_DATE=second_commit_time, GIT_COMMITTER_DATE=second_commit_time)
    subprocess.run(["git", "commit", "-q", "-m", "change moda"], cwd=repo, check=True, env=env)

    proc = run_tool(repo, "audit-scope", "--since", since_time)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["verdict"] == "ok"
    assert "resolved_commit" in payload
    assert "reviewed_revision" in payload
    for area_name, info in payload["areas"].items():
        assert "reviewed_fingerprint" in info, (area_name, info)
        assert "current_fingerprint" in info, (area_name, info)
    assert payload["areas"]["groupa"]["status"] == "in_scope"


# ------------------------------------------------- Slice A mechanical gaps


def test_pure_spawner_is_composition_selected_on_any_python_change(tmp_path):
    repo = base_repo(tmp_path)
    write(
        repo,
        "tests/test_pure_spawner_only.py",
        "import subprocess, sys\n\n\ndef test_spawns_unrecognizable():\n"
        "    subprocess.run([sys.executable, 'hub.py', 'not-a-real-subcommand'])\n",
    )
    base = commit(repo, "add a pure spawner test unrelated to any slice")

    # An unrelated python source changes; the pure spawner still runs.
    write(repo, "moda.py", "def a():\n    return 2\n")
    commit(repo, "change an unrelated module")

    payload = run_select(repo, base=base)
    assert "tests/test_pure_spawner_only.py" in payload["composition"]
    assert "tests/test_pure_spawner_only.py" in payload["selections"]["python"]


def test_fixture_reached_through_dynamic_directory_and_setup_ts(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/fixtures/usage/sample.json", "{}\n")
    write(
        repo,
        "app/src/test/setup.ts",
        "const DIR = 'tests/fixtures/usage/';\nexport const load = (name: string) => DIR + name;\n",
    )
    base = commit(repo, "add fixture and a dynamic-directory reader in setup.ts")

    write(repo, "tests/fixtures/usage/sample.json", '{"changed": true}\n')
    commit(repo, "change fixture read only via the directory prefix")

    payload = run_select(repo, base=base)
    # setup.ts is shared_infrastructure.vitest itself; touching a fixture
    # it reads by directory prefix must broaden vitest to catch it.
    assert payload["broaden"]["vitest"] is not None


def test_closure_ceiling_broadens_with_a_named_reason(tmp_path):
    repo = base_repo(tmp_path)
    # Two python test files total; one module's import graph already
    # covers both via a shared helper, so any change to it exceeds the
    # 0.6 ceiling and must broaden with reason: closure_ceiling.
    write(repo, "moda.py", "def a():\n    return 1\n")
    write(repo, "tests/test_moda.py", "import moda\n\ndef test_a():\n    assert moda.a() == 1\n")
    write(repo, "tests/test_modb.py", "import moda\n\ndef test_b():\n    assert moda.a() == 1\n")
    base = commit(repo, "both test files import moda")

    write(repo, "moda.py", "def a():\n    return 2\n")
    commit(repo, "change moda")

    payload = run_select(repo, base=base)
    assert payload["broaden"]["python"] is not None
    assert "closure_ceiling" in payload["broaden"]["python"]


def test_integration_case_selected_by_selector_intersection(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "moda.py", "def a():\n    return 5\n")
    commit(repo, "change moda, whose test is case.a's selector")

    payload = run_select(repo, base=base)
    assert "case.a" in payload["selections"]["integration"]
    assert "case.b" not in payload["selections"]["integration"]  # negative: unrelated case


def test_broadened_python_from_hub_source_adds_every_quick_case(tmp_path):
    """F4: a broadened python selection adds every quick-profile case
    ONLY when the broadening traces back to an actual hub source change
    — never just because some unrelated python-domain file broadened it,
    and never the intersection trick (which would trivially match every
    case once python is the whole suite)."""
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    # modb.py is hub source (groupb) and unrelated to case.a's selector
    # (test_moda.py); requirements.txt broadens python via shared infra.
    write(repo, "modb.py", "def b():\n    return 99\n")
    write(repo, "requirements.txt", "pyyaml\nrequests\n")
    commit(repo, "change hub source and broaden python via a dependency")

    payload = run_select(repo, base=base)
    assert payload["broaden"]["python"] is not None
    assert "case.a" in payload["selections"]["integration"]  # quick, added by broadening
    assert "case.b" in payload["selections"]["integration"]  # offline, but matched directly


def test_testing_scripts_change_is_not_hub_source(tmp_path):
    """F4: testing/scripts/** and scripts/** are Python but not hub
    source — cargo stays false, and a python broaden they trigger via
    shared infrastructure never adds every quick-profile case."""
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "testing/scripts/helper.py", "VALUE = 1\n")
    commit(repo, "add a tool-only helper under testing/scripts/**")

    payload = run_select(repo, base=base)
    assert payload["broaden"]["python"] is not None  # shared_infrastructure.python: testing/scripts/**
    assert payload["selections"]["cargo"] is False
    assert "case.a" not in payload["selections"]["integration"]
    assert "case.b" not in payload["selections"]["integration"]


def test_connector_compatibility_shim_is_hub_source(tmp_path):
    """The root connector shim is shipped runtime code and must trigger F4."""
    repo = base_repo(tmp_path)
    targets_with_connector = MINIMAL_TARGETS.replace(
        "  groupb:\n", "  connectors:\n    why: compatibility shim\n    paths:\n      - connectors\n  groupb:\n"
    ).replace("source_dirs: [skill_hub]", "source_dirs: [skill_hub, connectors]")
    write(repo, "mutation/targets.yaml", targets_with_connector)
    commit(repo, "add the connector mutation group")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "connectors/__init__.py", "from skill_hub.infrastructure.connectors import base\n")
    commit(repo, "add the connector compatibility shim")

    payload = run_select(repo, base=base)
    assert payload["unknown"] == []
    assert payload["broaden"] == {key: None for key in tool.RUNNER_KEYS}
    assert payload["selections"]["cargo"] is True


def test_report_only_paths_select_no_runner(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "testing/audits/x/report.md", "# report\n")
    write(repo, "docs/x.md", "# doc\n")
    write(repo, "TOPLEVEL.md", "# root doc\n")
    commit(repo, "add report-only paths")

    payload = run_select(repo, base=base)
    for p in ("testing/audits/x/report.md", "docs/x.md", "TOPLEVEL.md"):
        assert p in payload["report_only"], (p, payload["report_only"])
    assert not any(payload["broaden"].values())
    assert not payload["selections"]["python"]
    assert not payload["selections"]["vitest"]


def test_check_record_is_stale_after_a_command_change(tmp_path):
    """F9: check-record recomputes the fingerprint from the record's own
    stored inputs/commands/results — a tampered `commands` list (no real
    file touched) must not verify fresh."""
    _repo, out_path = _repo_with_recorded_modc(tmp_path)

    record_before = json.loads(out_path.read_text())
    tampered = dict(record_before)
    tampered["commands"] = [
        {"runner": "python", "argv": ["python3", "-m", "pytest", "-q"], "cwd": None, "env": {}}
    ]
    out_path.write_text(json.dumps(tampered))

    result = run_tool(_repo, "check-record", str(out_path))
    body = json.loads(result.stdout)
    assert body["verdict"] == "stale"
    assert body.get("reason") == "record_tampered"


def test_check_record_is_stale_after_a_results_change(tmp_path):
    _repo, out_path = _repo_with_recorded_modc(tmp_path)

    record_before = json.loads(out_path.read_text())
    tampered = dict(record_before)
    tampered["results"] = {"python": {"exit": 0, "collected": 1, "passed": 1, "failed": 5}}
    out_path.write_text(json.dumps(tampered))

    result = run_tool(_repo, "check-record", str(out_path))
    body = json.loads(result.stdout)
    assert body["verdict"] == "stale"
    assert body.get("reason") == "record_tampered"


def test_audit_scope_narrow_carried_area_needs_a_gaps_entry_when_complete(tmp_path):
    repo = base_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    manifest = complete_manifest(repo, head)
    # groupb is "carried" with a reviewed fingerprint that no longer
    # matches its current one, and status is complete with no gaps entry
    # naming it: invalid.
    manifest["areas"]["groupb"]["status"] = "carried"
    manifest["areas"]["groupb"]["current_fingerprint"] = "not-the-same-value"
    path_missing_gap = write_manifest(repo, "no-gap", manifest)
    bad = json.loads(run_tool(repo, "manifest", "validate", "--json", str(path_missing_gap)).stdout)
    assert bad["verdict"] == "invalid"
    assert any("differing fingerprint" in r for r in bad["reasons"])

    manifest["gaps"] = [{"area": "groupb", "reason": "content drifted, not yet reviewed"}]
    path_with_gap = write_manifest(repo, "with-gap", manifest)
    good = json.loads(run_tool(repo, "manifest", "validate", "--json", str(path_with_gap)).stdout)
    assert "differing fingerprint" not in " ".join(good["reasons"])


# ------------------------------------------------------- F3 on the real repo


@needs_repo_git
def test_real_repo_one_slice_change_stays_under_the_hub_py_sink_fanout(tmp_path):
    """F3: without the hub.py sink, a one-slice closure balloons to over
    half the suite (110 of 202 pytest files, observed) by walking THROUGH
    hub.py into every test that merely does `import hub`. In-process
    against the real tree — no git mutation, no worktree write."""
    repo = REPO_ROOT
    all_files = tool.list_working_files(repo)
    python_files = tool._python_files(all_files)
    python_test_files = {f for f in all_files if tool.glob_match(f, "tests/test_*.py")}
    py_reverse = tool.build_python_reverse_graph(repo, python_files, python_test_files)
    owners = (
        tool.transitive_dependents(
            "skill_hub/entrypoints/cli/permissions.py", py_reverse, sinks=tool.PY_GRAPH_SINKS
        )
        & python_test_files
    )
    without_sink = (
        tool.transitive_dependents("skill_hub/entrypoints/cli/permissions.py", py_reverse, sinks=frozenset())
        & python_test_files
    )
    # The reported number was 110 of 202 (measured pre-fix at 59%, just
    # under the closure ceiling). The hub.py sink alone brings this
    # specific slice from ~111 to ~38 (real, verified improvement); the
    # residual comes from genuine hub_cli-to-hub_cli import chains
    # (skill.py -> archive.py -> mcp.py -> a test), not the facade fan-out
    # this fix targets. Assert the improvement is real and substantial,
    # not the unverified "<20" figure.
    assert len(owners) < len(without_sink) / 2, (len(owners), len(without_sink))
    assert len(owners) < 50, sorted(owners)


# ---------------------------------------------- journeys -> spec files (F1)


def test_app_source_change_selects_the_areas_journey_spec_files(tmp_path):
    """F1: a journey name alone selects no runner — it must resolve to
    real `app/e2e/<name>.spec.ts` / `<name>.journey.spec.ts` files, land
    in selections.e2e, and produce a real Playwright argv."""
    repo = base_repo(tmp_path)
    write(repo, "app/e2e/shell-journey.spec.ts", "test('shell journey', () => {});\n")
    write(repo, "app/e2e/unrelated.spec.ts", "test('unrelated', () => {});\n")
    commit(repo, "add the shell area's journey spec and an unrelated one")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    write(repo, "app/src/App.tsx", "export const App = () => 1;\n")
    commit(repo, "change the shell area's source")

    payload = run_select(repo, base=base)
    assert "app/e2e/shell-journey.spec.ts" in payload["selections"]["e2e"]
    assert "app/e2e/unrelated.spec.ts" not in payload["selections"]["e2e"]  # negative
    assert "shell-journey" in payload["journeys"]

    e2e_commands = [c for c in payload["commands"] if c["runner"] == "e2e"]
    assert e2e_commands, payload["commands"]
    assert e2e_commands[0]["argv"] == ["npx", "playwright", "test", "e2e/shell-journey.spec.ts"]
    assert e2e_commands[0]["cwd"] == "app"


# ----------------------------------------------- commands argv/cwd/env


def test_commands_have_correct_argv_cwd_and_env_shapes(tmp_path):
    repo = base_repo(tmp_path)
    # A second, unrelated vitest test committed BEFORE `base`, so the one
    # real selection below stays under the 0.6 closure ceiling instead of
    # broadening (both files would otherwise change together).
    write(repo, "app/src/Other.tsx", "export const Other = () => 1;\n")
    write(repo, "app/src/Other.test.tsx", "test('other', () => {});\n")
    base = commit(repo, "add an unrelated vitest test")

    write(repo, "modc.py", "def c():\n    return 3\n")
    write(repo, "tests/test_modc.py", "import modc\n\ndef test_c():\n    assert modc.c() == 3\n")
    write(repo, "app/src/App.tsx", "export const App = () => 1;\n")
    commit(repo, "change python and vitest-owned sources together")

    payload = run_select(repo, base=base)
    by_runner = {c["runner"]: c for c in payload["commands"]}

    assert by_runner["python"]["argv"][:3] == ["python3", "-m", "pytest"]
    assert "tests/test_modc.py" in by_runner["python"]["argv"]
    assert by_runner["python"]["cwd"] is None

    assert by_runner["vitest"]["argv"][:3] == ["npx", "vitest", "run"]
    # cwd-relative: never the app/-prefixed repo-relative form.
    assert "src/App.test.tsx" in by_runner["vitest"]["argv"]
    assert not any(a.startswith("app/") for a in by_runner["vitest"]["argv"])
    assert by_runner["vitest"]["cwd"] == "app"


def test_static_commands_apply_without_changing_test_commands(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "modc.py", "def c():\n    return 3\n")
    write(repo, "tests/test_modc.py", "import modc\n\ndef test_c():\n    assert modc.c() == 3\n")
    commit(repo, "add python source")

    payload = run_select(repo, base=base)

    assert [item["argv"] for item in payload["static_commands"]] == [
        ["ruff", "check", "."],
        ["mypy"],
    ]
    assert all(item["runner"] == "python-static" for item in payload["static_commands"])
    assert payload["commands"] == tool.build_commands(
        tool.load_test_map(repo),
        {
            "python": set(payload["selections"]["python"]),
            "vitest": set(payload["selections"]["vitest"]),
            "e2e": set(payload["selections"]["e2e"]),
            "cargo": payload["selections"]["cargo"],
            "integration": set(payload["selections"]["integration"]),
        },
        payload["broaden"],
    )


def test_app_documentation_still_selects_frontend_static_commands(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/README.md", "before\n")
    base = commit(repo, "add app documentation")
    write(repo, "app/README.md", "after\n")
    commit(repo, "change only app documentation")

    payload = run_select(repo, base=base)

    assert payload["commands"] == []
    assert [item["argv"] for item in payload["static_commands"]] == [
        ["npx", "tsc", "--noEmit"],
        ["npm", "run", "lint"],
    ]
    assert all(item["cwd"] == "app" for item in payload["static_commands"])


def test_static_command_parser_rejects_shell_chains(tmp_path):
    repo = base_repo(tmp_path)
    test_map = tool.load_test_map(repo)
    test_map["runners"]["python"]["static"] = ["ruff check . && echo unsafe"]

    with pytest.raises(tool.ToolError, match="unsupported runners.python.static"):
        tool.build_static_commands(test_map, ["moda.py"], {"python": ["tests/test_moda.py"]})


def test_integration_command_has_a_real_isolated_home_env(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "moda.py", "def a():\n    return 5\n")
    commit(repo, "change moda, case.a's selector")

    payload = run_select(repo, base=base)
    integration = next(c for c in payload["commands"] if c["runner"] == "integration")
    for key in ("HOME", "SKILL_HUB_HOME", "PYTHONUSERBASE"):
        assert key in integration["env"], integration["env"]
        assert integration["env"][key] != "{tmp}"
        assert Path(integration["env"][key]).is_dir()
    # All three point at the SAME fresh directory.
    assert len({integration["env"][k] for k in ("HOME", "SKILL_HUB_HOME", "PYTHONUSERBASE")}) == 1


def test_deleted_test_never_appears_in_any_argv(tmp_path):
    repo = base_repo(tmp_path)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    (repo / "tests" / "test_moda.py").unlink()
    commit(repo, "delete test_moda.py")

    payload = run_select(repo, base=base)
    assert "tests/test_moda.py" in payload["deleted_tests"]
    assert "tests/test_moda.py" not in payload["selections"]["python"]
    for command in payload["commands"]:
        assert "tests/test_moda.py" not in command["argv"]


def test_cross_reader_reads_wins_over_report_only_for_markdown(tmp_path):
    """F2 (defect): a `reads` match on Markdown selects its reader
    instead of being inert; unmatched Markdown stays report_only."""
    repo = base_repo(tmp_path)
    map_with_skill_reader = MINIMAL_TEST_MAP.replace(
        "cross_readers:\n",
        "cross_readers:\n"
        "  - runner: python\n"
        "    path: tests/test_starter_pack_contents.py\n"
        "    reads: [\"skills/**\"]\n"
        "  - runner: python\n"
        "    path: tests/test_testing_skills.py\n"
        "    reads: [\"AGENTS.md\"]\n",
        1,
    )
    write(repo, "testing/test-map.yaml", map_with_skill_reader)
    write(repo, "tests/test_starter_pack_contents.py", "def test_x():\n    assert True\n")
    write(repo, "tests/test_testing_skills.py", "def test_y():\n    assert True\n")
    write(repo, "AGENTS.md", "# root doc\n")
    write(repo, "skills/x/SKILL.md", "---\nname: x\n---\nbody\n")
    write(repo, "docs/foo.md", "# unrelated doc\n")
    base = commit(repo, "add cross-reader-eligible markdown")

    write(repo, "skills/x/SKILL.md", "---\nname: x\n---\nchanged\n")
    write(repo, "AGENTS.md", "# root doc, changed\n")
    write(repo, "docs/foo.md", "# unrelated doc, changed\n")
    commit(repo, "change all three markdown files")

    payload = run_select(repo, base=base)
    assert "tests/test_starter_pack_contents.py" in payload["selections"]["python"]
    assert "tests/test_testing_skills.py" in payload["selections"]["python"]
    assert "docs/foo.md" in payload["report_only"]
    entries = {c["path"]: c for c in payload["changed"]}
    assert entries["skills/x/SKILL.md"]["kind"] == "source"
    assert entries["AGENTS.md"]["kind"] == "source"
    assert entries["docs/foo.md"]["kind"] == "report_only"


# --------------------------------------------------- area test ownership


def test_area_paths_contain_only_the_areas_own_tests(tmp_path):
    """Positive and negative: groupa's paths must include test_moda.py
    (convention) and must NOT include test_modb.py (groupb's own test)."""
    repo = base_repo(tmp_path)
    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    areas, area_extra = tool.build_areas_with_ownership(repo, test_map, targets)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    _fp, paths = tool.area_fingerprint(repo, head, areas["groupa"], area_extra["groupa"])
    assert "tests/test_moda.py" in paths
    assert "tests/test_modb.py" not in paths  # negative: owned by groupb, not groupa


def test_a_test_touching_two_groups_appears_in_both(tmp_path):
    repo = base_repo(tmp_path)
    write(
        repo,
        "tests/test_cross_group.py",
        "import moda\nimport modb\n\n\ndef test_both():\n    assert moda.a() == 1\n    assert modb.b() == 2\n",
    )
    commit(repo, "add a test that imports both groups' modules")

    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    ownership = tool.compute_area_test_ownership(repo, test_map, targets)
    assert "tests/test_cross_group.py" in ownership["groupa"]
    assert "tests/test_cross_group.py" in ownership["groupb"]


def test_orphan_test_lands_in_unowned_tests(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/test_orphan_thing.py", "def test_nothing():\n    assert True\n")
    commit(repo, "add a test that owns/imports nothing")

    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    areas, area_extra = tool.build_areas_with_ownership(repo, test_map, targets)
    assert "unowned-tests" in areas
    assert "tests/test_orphan_thing.py" in area_extra["unowned-tests"]
    # negative: not also claimed by an unrelated group
    assert "tests/test_orphan_thing.py" not in area_extra["groupa"]


def test_app_area_owns_its_vitest_and_journey_spec_files(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/e2e/shell-journey.spec.ts", "test('shell journey', () => {});\n")
    commit(repo, "add the shell area's journey spec")

    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    ownership = tool.compute_area_test_ownership(repo, test_map, targets)
    assert "app/src/App.test.tsx" in ownership["app:shell"]
    assert "app/e2e/shell-journey.spec.ts" in ownership["app:shell"]


# --------------------------------------------- area test ownership (real repo)


@needs_repo_git
def test_real_repo_group_areas_own_a_bounded_test_set():
    repo = REPO_ROOT
    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    areas, area_extra = tool.build_areas_with_ownership(repo, test_map, targets)
    head = tool.rev_parse(repo, "HEAD")

    _fp, harness_paths = tool.area_fingerprint(
        repo, head, areas["harness_compatibility"], area_extra["harness_compatibility"]
    )
    harness_tests = {p for p in harness_paths if tool.glob_match(p, "tests/test_*.py")}
    assert len(harness_tests) < 40, sorted(harness_tests)

    _fp, server_paths = tool.area_fingerprint(repo, head, areas["server"], area_extra["server"])
    server_tests = {p for p in server_paths if tool.glob_match(p, "tests/test_*.py")}
    assert len(server_tests) < 10, sorted(server_tests)


@needs_repo_git
def test_real_repo_every_test_file_appears_in_at_least_one_area():
    repo = REPO_ROOT
    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    areas, area_extra = tool.build_areas_with_ownership(repo, test_map, targets)
    head = tool.rev_parse(repo, "HEAD")

    all_files = tool.list_tracked_files(repo, head)
    all_python_tests = {f for f in all_files if tool.glob_match(f, "tests/test_*.py")}

    covered: set = set()
    for area_name, globs in areas.items():
        _fp, paths = tool.area_fingerprint(repo, head, globs, area_extra.get(area_name, set()))
        covered |= set(paths) & all_python_tests

    missing = all_python_tests - covered
    assert not missing, sorted(missing)
    assert area_extra["unowned-tests"], "expected at least one real orphan test"


def test_feedback_store_change_selects_feedback_journey_with_real_map(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "testing/test-map.yaml", (REPO_ROOT / "testing/test-map.yaml").read_text())
    write(repo, "app/src/store/feedback.ts", "export const draft = '';\n")
    write(repo, "app/e2e/feedback.journey.spec.ts", "test('feedback', () => {});\n")
    commit(repo, "add feedback files and the repository map")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    write(repo, "app/src/store/feedback.ts", "export const draft = 'changed';\n")
    commit(repo, "change feedback draft state")

    payload = run_select(repo, base=base)

    assert "feedback" in payload["journeys"]
    assert "app/e2e/feedback.journey.spec.ts" in payload["selections"]["e2e"]


# ------------------------------------------- package modules (round 5, #1)


def test_synthetic_package_module_is_visible_to_the_import_graph(tmp_path):
    """A `.py` file under a `source_dirs` package (like `connectors/`) must
    get an import-graph node — previously only root modules and
    `hub_cli/**` did, so package-internal files had no dependents at all.
    """
    repo = base_repo(tmp_path)
    write(repo, "widgets/__init__.py", "")
    write(repo, "widgets/gadget.py", "def make():\n    return 1\n")
    targets_with_package = MINIMAL_TARGETS.replace(
        "groups:\n",
        "groups:\n  widgets:\n    why: x\n    paths:\n      - widgets\n",
        1,
    ).replace("source_dirs: []", 'source_dirs: ["widgets"]')
    write(repo, "mutation/targets.yaml", targets_with_package)
    write(
        repo,
        "tests/test_gadget_user.py",
        "from widgets.gadget import make\n\n\ndef test_make():\n    assert make() == 1\n",
    )
    base = commit(repo, "add a package module and its direct importer")

    write(repo, "widgets/gadget.py", "def make():\n    return 2\n")
    commit(repo, "change the package module")

    payload = run_select(repo, base=base)
    assert "tests/test_gadget_user.py" in payload["selections"]["python"]


@needs_repo_git
def test_real_repo_connectors_module_reaches_its_direct_importers():
    """The proof case: `connectors/transport/ssh.py` (an 18-file package
    with no top-level `.py`) must have real import-graph edges to its
    direct importers. Checked via the graph itself, not a single-commit
    `select` diff — `tests/test_loadout_control.py` was added to the repo
    AFTER commit 0b6dad6c, so it cannot appear in that one commit's own
    diff regardless of the fix; the graph edge is what the defect was
    actually about.
    """
    repo = REPO_ROOT
    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    all_files = tool.list_working_files(repo)
    graphs = tool.OwnershipGraphs(repo, test_map, targets, all_files)
    assert "skill_hub/infrastructure/connectors/transport/ssh.py" in graphs.python_files
    dependents = graphs.py_reverse.get("skill_hub/infrastructure/connectors/transport/ssh.py", set())
    assert "tests/test_remote_framework.py" in dependents
    assert "tests/test_loadout_control.py" in dependents


def test_real_repo_select_on_the_proof_commit_selects_remote_framework():
    """Needs the proof commit and its parent in the object store. CI checks
    out with ``fetch-depth: 1``, so this is a local-only proof there."""
    probe = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--verify", "--quiet", "0b6dad6c^{commit}"],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0 or not any((REPO_ROOT / "hub_cli").glob("*.py")):
        pytest.skip("proof commit 0b6dad6c is not in this checkout (shallow clone)")
    proc = subprocess.run(
        [sys.executable, str(TOOL), "select", "--base", "0b6dad6c^", "--head", "0b6dad6c",
         "--json", "--repo", str(REPO_ROOT)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert "tests/test_remote_framework.py" in payload["selections"]["python"]


# ------------------------------------ subprocess-family via AST (round 5, #2)


def test_subcommand_word_only_in_a_comment_is_not_attributed(tmp_path):
    """The word appearing only in a comment/docstring must not attribute
    the test to the slice's group — checked directly against
    `compute_hub_reference_hits`, since a pure `hub.py` spawner with no
    recognizable subcommand is ALSO separately selected via `composition`
    on any Python change, which would mask the bug if checked through
    `select`'s overall `selections.python`.
    """
    repo = base_repo(tmp_path)
    write(repo, "skill_hub/entrypoints/cli/__init__.py", "")
    write(repo, "skill_hub/entrypoints/cli/hook.py", 'NAME = "hook"\n\n\ndef cmd_hook():\n    return 1\n')
    targets_with_slice = MINIMAL_TARGETS.replace(
        "groups:\n",
        "groups:\n  cli_hook:\n    why: x\n    paths:\n      - skill_hub/entrypoints/cli/hook.py\n",
        1,
    )
    write(repo, "mutation/targets.yaml", targets_with_slice)
    write(
        repo,
        "tests/test_bundle_style.py",
        "import subprocess, sys\n\n\n"
        "def test_spawns_something():\n"
        "    # this test stubs the hook stream, see hub.py for context\n"
        "    subprocess.run([sys.executable, 'hub.py', 'zzz-unrelated'])\n",
    )
    commit(repo, "add a test that mentions 'hook' only in a comment")

    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    ownership = tool.compute_area_test_ownership(repo, test_map, targets)
    assert "tests/test_bundle_style.py" not in ownership.get("cli_hook", set())


def test_subcommand_word_as_argv_literal_is_attributed(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "skill_hub/entrypoints/cli/__init__.py", "")
    write(repo, "skill_hub/entrypoints/cli/hook.py", 'NAME = "hook"\n\n\ndef cmd_hook():\n    return 1\n')
    targets_with_slice = MINIMAL_TARGETS.replace(
        "groups:\n",
        "groups:\n  cli_hook:\n    why: x\n    paths:\n      - skill_hub/entrypoints/cli/hook.py\n",
        1,
    )
    write(repo, "mutation/targets.yaml", targets_with_slice)
    write(
        repo,
        "tests/test_hook_argv.py",
        "import subprocess, sys\n\n\n"
        "def test_spawns_hook():\n"
        "    subprocess.run([sys.executable, 'hub.py', 'hook'])\n",
    )
    base = commit(repo, "add a test with the subcommand as an argv literal")

    write(repo, "skill_hub/entrypoints/cli/hook.py", 'NAME = "hook"\n\n\ndef cmd_hook():\n    return 2\n')
    commit(repo, "change the hook slice")

    payload = run_select(repo, base=base)
    assert "tests/test_hook_argv.py" in payload["selections"]["python"]


def test_real_repo_bundle_link_test_is_not_in_the_hooks_area(tmp_path):
    repo = REPO_ROOT
    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    ownership = tool.compute_area_test_ownership(repo, test_map, targets)
    assert "tests/test_bundle_link.py" not in ownership.get("hooks", set())


def test_relative_import_and_package_initializer_select_importer_test(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "skill_hub/widgets/__init__.py", "ENABLED = True\n")
    write(repo, "skill_hub/widgets/core.py", "VALUE = 1\n")
    write(repo, "skill_hub/widgets/use.py", "from . import core\n\ndef value():\n    return core.VALUE\n")
    write(
        repo,
        "tests/test_widget_use.py",
        "from skill_hub.widgets.use import value\n\ndef test_value():\n    assert value() == 1\n",
    )
    base = commit(repo, "add relative import package")

    write(repo, "skill_hub/widgets/__init__.py", "ENABLED = False\n")
    commit(repo, "change package initializer")

    payload = run_select(repo, base=base)
    assert "tests/test_widget_use.py" in payload["selections"]["python"]
    assert payload["uncertainty"] == []


def test_test_helper_dependency_selects_importing_test(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "tests/helpers.py", "VALUE = 1\n")
    write(
        repo,
        "tests/test_helper_user.py",
        "from tests.helpers import VALUE\n\ndef test_value():\n    assert VALUE == 1\n",
    )
    base = commit(repo, "add test helper")

    write(repo, "tests/helpers.py", "VALUE = 2\n")
    commit(repo, "change test helper")

    payload = run_select(repo, base=base)
    assert "tests/test_helper_user.py" in payload["selections"]["python"]


@pytest.mark.parametrize("asset_name", ["theme.css", "labels.json"])
def test_typescript_asset_change_selects_importing_test(tmp_path, asset_name):
    repo = base_repo(tmp_path)
    write(repo, f"app/src/lib/{asset_name}", "before\n")
    write(
        repo,
        "app/src/components/AssetConsumer.tsx",
        f'import "../lib/{asset_name}";\nexport const AssetConsumer = () => null;\n',
    )
    write(
        repo,
        "app/src/components/AssetConsumer.test.tsx",
        "import { AssetConsumer } from './AssetConsumer';\n"
        "test('asset', () => AssetConsumer());\n",
    )
    base = commit(repo, f"add {asset_name} importer")

    write(repo, f"app/src/lib/{asset_name}", "after\n")
    commit(repo, f"change {asset_name}")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "app/src/components/AssetConsumer.test.tsx" in payload["selections"]["vitest"]
    assert payload["broaden"]["vitest"] is None


@pytest.mark.parametrize("operation", ["delete", "rename"])
def test_typescript_asset_delete_or_rename_keeps_importing_test(tmp_path, operation):
    repo = base_repo(tmp_path)
    write(repo, "app/src/lib/theme.css", "before\n")
    write(
        repo,
        "app/src/components/AssetConsumer.tsx",
        'import "../lib/theme.css";\nexport const AssetConsumer = () => null;\n',
    )
    write(
        repo,
        "app/src/components/AssetConsumer.test.tsx",
        "import { AssetConsumer } from './AssetConsumer';\n"
        "test('asset', () => AssetConsumer());\n",
    )
    base = commit(repo, "add asset importer")

    if operation == "delete":
        (repo / "app/src/lib/theme.css").unlink()
    else:
        run_git(repo, "mv", "app/src/lib/theme.css", "app/src/lib/theme-renamed.css")
    commit(repo, f"{operation} asset")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "app/src/components/AssetConsumer.test.tsx" in payload["selections"]["vitest"]


def test_missing_or_unsupported_typescript_asset_import_broadens_frontend(tmp_path):
    repo = base_repo(tmp_path)
    write(
        repo,
        "app/src/components/AssetConsumer.tsx",
        'import "../lib/theme.scss";\nexport const AssetConsumer = () => null;\n',
    )
    base = commit(repo, "add unsupported asset importer")

    write(repo, "app/src/lib/theme.scss", "after\n")
    commit(repo, "change unsupported asset")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert payload["broaden"]["vitest"] is not None
    assert payload["broaden"]["e2e"] is not None
    assert any(item["reason"] == "typescript_local_import_unresolved" for item in payload["uncertainty"])


def test_e2e_spec_change_selects_python_map_guard(tmp_path):
    repo = base_repo(tmp_path)
    map_text = MINIMAL_TEST_MAP.replace(
        "report_only:",
        "cross_readers:\n"
        "  - runner: python\n"
        "    path: tests/test_testing_skills.py\n"
        "    reads: [\"app/e2e/*.spec.ts\"]\n"
        "report_only:",
    )
    write(repo, "testing/test-map.yaml", map_text)
    base = commit(repo, "register e2e ownership guard")

    write(repo, "app/e2e/shell.spec.ts", "test('shell changed', () => {});\n")
    commit(repo, "change e2e journey")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "tests/test_testing_skills.py" in payload["selections"]["python"]


def test_deleted_e2e_spec_selects_python_map_guard(tmp_path):
    repo = base_repo(tmp_path)
    map_text = MINIMAL_TEST_MAP.replace(
        "report_only:",
        "cross_readers:\n"
        "  - runner: python\n"
        "    path: tests/test_testing_skills.py\n"
        "    reads: [\"app/e2e/*.spec.ts\"]\n"
        "report_only:",
    )
    write(repo, "testing/test-map.yaml", map_text)
    base = commit(repo, "register e2e ownership guard")

    (repo / "app/e2e/shell.spec.ts").unlink()
    commit(repo, "delete e2e journey")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "tests/test_testing_skills.py" in payload["selections"]["python"]


def test_dynamic_parent_typescript_import_selects_dependent_test(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/lib/value.ts", "export const value = 1;\n")
    write(repo, "app/src/features/load.ts", "export const load = () => import('../lib/value');\n")
    write(repo, "app/src/features/load.test.ts", "import { load } from './load';\ntest('load', () => load());\n")
    base = commit(repo, "add dynamic import")

    write(repo, "app/src/lib/value.ts", "export const value = 2;\n")
    commit(repo, "change dynamic dependency")

    payload = run_select(repo, base=base)
    assert "app/src/features/load.test.ts" in payload["selections"]["vitest"]
    assert payload["uncertainty"] == []


def test_typescript_js_reexport_resolves_to_source_module(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/lib/value.ts", "export const value = 1;\n")
    write(repo, "app/src/features/load.ts", "export { value } from '../lib/value.js';\n")
    write(repo, "app/src/features/load.test.ts", "import { value } from './load';\ntest('load', () => value);\n")
    base = commit(repo, "add emitted-extension re-export")

    write(repo, "app/src/lib/value.ts", "export const value = 2;\n")
    commit(repo, "change re-exported source")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "app/src/features/load.test.ts" in payload["selections"]["vitest"]
    assert payload["uncertainty"] == []


def test_static_template_literal_dynamic_import_is_an_edge(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/lib/value.ts", "export const value = 1;\n")
    write(repo, "app/src/features/load.ts", "export const load = () => import(`../lib/value`);\n")
    write(repo, "app/src/features/load.test.ts", "import { load } from './load';\ntest('load', () => load());\n")
    base = commit(repo, "add template-literal import")

    write(repo, "app/src/lib/value.ts", "export const value = 2;\n")
    commit(repo, "change imported source")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "app/src/features/load.test.ts" in payload["selections"]["vitest"]
    assert payload["uncertainty"] == []


def test_dynamic_import_words_in_comments_and_strings_do_not_broaden(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/lib/value.ts", "export const value = 1;\n")
    write(
        repo,
        "app/src/components/prose.tsx",
        "// Show the most recent import (sorted by timestamp).\n"
        'export const message = "Cannot import (blocked items)";\n'
        "export const Banner = () => <p>Cannot import ({1})</p>;\n"
        "/* Asserting the import (not another implementation). */\n",
    )
    write(repo, "app/src/lib/value.test.ts", "import { value } from './value';\ntest('value', () => value);\n")
    base = commit(repo, "add prose containing import words")

    write(repo, "app/src/lib/value.ts", "export const value = 2;\n")
    commit(repo, "change ordinary app source")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert payload["uncertainty"] == []
    assert payload["broaden"]["vitest"] is None
    assert payload["broaden"]["e2e"] is None
    assert payload["selections"]["vitest"] == ["app/src/lib/value.test.ts"]


def test_real_computed_dynamic_import_broadens_frontend(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/lib/value.ts", "export const value = 1;\n")
    write(repo, "app/src/features/load.ts", "export const load = (name: string) => import(name);\n")
    base = commit(repo, "add computed dynamic import")

    write(repo, "app/src/lib/value.ts", "export const value = 2;\n")
    commit(repo, "change possible dynamic dependency")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert payload["broaden"]["vitest"] is not None
    assert payload["broaden"]["e2e"] is not None
    assert {item["reason"] for item in payload["uncertainty"]} == {
        "typescript_dynamic_import_unresolved"
    }


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("void import(name);", [(None, True)]),
        ("const value = 1\nimport(name);", [(None, True)]),
        (
            'const first = import("./first"); const other = import(name);',
            [("./first", False), (None, True)],
        ),
    ],
)
def test_dynamic_import_scanner_keeps_valid_code_contexts(source, expected):
    assert tool._ts_dynamic_imports(source) == expected


@pytest.mark.parametrize(
    "source",
    [
        "const banner = <p>text</p>; import(name);",
        "const banner = <Banner />; import(name);",
        "const value = fn<Type>(); import(name);",
        "const rendered = `value: ${await import(name)}`;",
    ],
)
def test_dynamic_import_scanner_does_not_suppress_real_code_after_markup(source):
    assert tool._ts_dynamic_imports(source) == [(None, True)]


def test_vitest_test_change_does_not_broaden_e2e_for_unrelated_prose(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/components/prose.ts", "export const text = 'Cannot import (items)';\n")
    write(repo, "app/src/test/leaf.test.ts", "test('leaf', () => {});\n")
    base = commit(repo, "add frontend test and prose")

    write(repo, "app/src/test/leaf.test.ts", "test('leaf changed', () => {});\n")
    commit(repo, "change only frontend test")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert payload["selections"]["vitest"] == ["app/src/test/leaf.test.ts"]
    assert payload["selections"]["e2e"] == []
    assert payload["broaden"]["e2e"] is None
    assert payload["uncertainty"] == []


def test_python_helper_outside_owned_packages_stays_in_graph(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "scripts/helper.py", "import moda\n\ndef value():\n    return moda.VALUE\n")
    write(
        repo,
        "tests/test_consumer.py",
        "from scripts.helper import value\n\ndef test_value():\n    assert value() == 1\n",
    )
    write(repo, "tests/test_moda.py", "import moda\n\ndef test_moda():\n    assert moda.VALUE == 1\n")
    write(repo, "moda.py", "VALUE = 1\n")
    base = commit(repo, "add helper dependency outside mutation packages")

    write(repo, "moda.py", "VALUE = 2\n")
    commit(repo, "change helper dependency")

    payload = run_select(repo, base=base, extra=["--head", "HEAD"])
    assert "tests/test_consumer.py" in payload["selections"]["python"]


def test_semantic_fingerprint_tracks_untracked_but_ignores_ignored(tmp_path):
    repo = base_repo(tmp_path)
    before = tool.semantic_fingerprint(repo, worktree=True)
    write(repo, "new_input.xyz", "relevant\n")
    after_untracked = tool.semantic_fingerprint(repo, worktree=True)
    assert after_untracked["fingerprint"] != before["fingerprint"]
    assert after_untracked["input_count"] == before["input_count"] + 1

    write(repo, ".gitignore", "generated/\n")
    commit(repo, "ignore generated output")
    clean = tool.semantic_fingerprint(repo, worktree=True)
    write(repo, "generated/cache.bin", "ignored\n")
    ignored = tool.semantic_fingerprint(repo, worktree=True)
    assert ignored == clean


def test_fingerprint_cli_matches_public_function(tmp_path):
    repo = base_repo(tmp_path)
    proc = run_tool(repo, "fingerprint", "--ref", "HEAD", "--json")
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == tool.semantic_fingerprint(repo, ref="HEAD")


def test_semantic_fingerprint_cross_reader_overrides_doc_exclusion(tmp_path):
    repo = base_repo(tmp_path)
    mapped = MINIMAL_TEST_MAP.replace(
        'reads: ["*.py"]', 'reads: ["*.py", "docs/runtime.md"]'
    )
    write(repo, "testing/test-map.yaml", mapped)
    commit(repo, "declare runtime-read documentation")
    before = tool.semantic_fingerprint(repo, worktree=True)

    write(repo, "docs/runtime.md", "runtime input\n")
    after = tool.semantic_fingerprint(repo, worktree=True)

    assert after["fingerprint"] != before["fingerprint"]
    assert "docs/runtime.md" not in after["excluded_paths"]


def test_semantic_fingerprint_tracks_unstaged_mode_changes(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "mode_probe", "content\n")
    commit(repo, "add non-executable input")
    before = tool.semantic_fingerprint(repo, worktree=True)

    os.chmod(repo / "mode_probe", 0o755)
    after = tool.semantic_fingerprint(repo, worktree=True)

    assert after["fingerprint"] != before["fingerprint"]


def test_semantic_fingerprint_distinguishes_regular_file_from_symlink(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "target", "payload\n")
    write(repo, "mode_probe", "target")
    commit(repo, "add regular input matching a future link target")
    before = tool.semantic_fingerprint(repo, worktree=True)

    (repo / "mode_probe").unlink()
    (repo / "mode_probe").symlink_to("target")
    after = tool.semantic_fingerprint(repo, worktree=True)

    assert after["fingerprint"] != before["fingerprint"]


def test_committed_and_worktree_fingerprints_match_for_symlinks(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "target", "payload\n")
    (repo / "linked_input").symlink_to("target")
    commit(repo, "add symlink input")

    committed = tool.semantic_fingerprint(repo, ref="HEAD")
    worktree = tool.semantic_fingerprint(repo, worktree=True)

    assert worktree["fingerprint"] == committed["fingerprint"]
    assert worktree["input_count"] == committed["input_count"]


# ----------------------------------------- unowned-tests, every runner


def test_orphan_vitest_file_lands_in_unowned_tests(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "app/src/Islanded.tsx", "export const Islanded = () => 1;\n")
    write(repo, "app/src/Islanded.test.tsx", "test('islanded', () => {});\n")
    commit(repo, "add a vitest file nothing else imports and no area covers")

    test_map = tool.load_test_map(repo)
    targets = tool.load_targets(repo)
    areas, area_extra = tool.build_areas_with_ownership(repo, test_map, targets)
    assert "app/src/Islanded.test.tsx" in area_extra["unowned-tests"]


# --------------------------------------------------- obligations (TA-1-obligations)

OBLIGATIONS_TEST_MAP = (
    MINIMAL_TEST_MAP
    + """\
obligations:
  component_sources: ["app/src/screens/**/*.tsx", "app/src/components/**/*.tsx"]
  subparser_sources: ["hub.py", "cli_widget.py"]
obligations_waived: []
"""
)


def _obligations_repo(tmp_path):
    repo = base_repo(tmp_path)
    write(repo, "testing/test-map.yaml", OBLIGATIONS_TEST_MAP)
    return repo


def _obligations_of(payload: Dict, kind: str, path: str) -> List[Dict]:
    return [
        item
        for item in payload["obligations"]
        if item["kind"] == kind and item["path"] == path
    ]


def _obligation(payload: Dict, kind: str, path: str, subcommand: Optional[str] = None) -> Optional[Dict]:
    items = _obligations_of(payload, kind, path)
    if subcommand is not None:
        items = [i for i in items if i.get("subcommand") == subcommand]
    assert len(items) <= 1, items
    return items[0] if items else None


def test_subparser_paths_nested_and_alias_shapes():
    text = (
        "def register(sub):\n"
        "    p = sub.add_parser('widget')\n"
        "    w = p.add_subparsers()\n"
        "    w.add_parser('list')\n"
        "    for alias in ('fix', 'migrate'):\n"
        "        sub.add_parser(alias)\n"
        "    sub.add_parser('version')\n"
    )
    paths = tool.subparser_paths(text)
    # 'widget' and its nested 'widget list' are present; the alias-loop
    # calls (a non-literal Name first argument) contribute nothing.
    assert paths == {("widget",), ("widget", "list"), ("version",)}


def test_new_component_without_direct_vitest_importer_is_unmet(tmp_path):
    repo = _obligations_repo(tmp_path)
    base = commit(repo, "map with obligations configured")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    commit(repo, "add a new screen with no test")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx")
    assert item is not None
    assert item["status"] == "unmet"
    assert item["evidence"] == []
    assert "unmet_obligations" in payload["reasons"]


def test_new_component_with_direct_vitest_importer_is_met(tmp_path):
    repo = _obligations_repo(tmp_path)
    base = commit(repo, "map with obligations configured")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    write(
        repo,
        "app/src/test/Widget.test.tsx",
        "import { Widget } from '../screens/Widget';\ntest('widget', () => Widget());\n",
    )
    commit(repo, "add a new screen with a direct vitest importer")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx")
    assert item is not None
    assert item["status"] == "met"
    assert item["evidence"] == ["app/src/test/Widget.test.tsx"]
    assert "unmet_obligations" not in payload["reasons"]


def test_transitive_only_importer_does_not_meet_component_obligation(tmp_path):
    repo = _obligations_repo(tmp_path)
    base = commit(repo, "map with obligations configured")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    write(
        repo,
        "app/src/components/WidgetWrapper.tsx",
        "import { Widget } from '../screens/Widget';\nexport const WidgetWrapper = () => Widget();\n",
    )
    write(
        repo,
        "app/src/test/WidgetWrapper.test.tsx",
        "import { WidgetWrapper } from '../components/WidgetWrapper';\n"
        "test('wrapper', () => WidgetWrapper());\n",
    )
    commit(repo, "add a new screen reached only transitively, through a wrapper, by a test")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx")
    assert item is not None
    assert item["status"] == "unmet"  # the test imports WidgetWrapper, not Widget, directly
    assert item["evidence"] == []


def test_modified_component_raises_no_obligation(tmp_path):
    repo = _obligations_repo(tmp_path)
    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    base = commit(repo, "add a component before this change")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => 1;\n")
    commit(repo, "modify the existing component, add no test")

    payload = run_select(repo, base=base)
    assert _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx") is None
    assert "unmet_obligations" not in payload["reasons"]


def test_waived_component_obligation_is_waived(tmp_path):
    repo = _obligations_repo(tmp_path)
    waived_map = OBLIGATIONS_TEST_MAP.replace(
        "obligations_waived: []",
        "obligations_waived:\n"
        '  - {kind: vitest_importer, path: app/src/screens/Widget.tsx, '
        'reason: "tested only through ParentScreen"}\n',
    )
    write(repo, "testing/test-map.yaml", waived_map)
    base = commit(repo, "map with a pre-registered waiver")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    commit(repo, "add the waived component")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx")
    assert item is not None
    assert item["status"] == "waived"
    assert item["reason"] == "tested only through ParentScreen"
    assert "unmet_obligations" not in payload["reasons"]


@pytest.mark.parametrize("empty_reason", ["", "   "])
def test_waiver_with_empty_reason_does_not_waive(tmp_path, empty_reason):
    repo = _obligations_repo(tmp_path)
    waived_map = OBLIGATIONS_TEST_MAP.replace(
        "obligations_waived: []",
        "obligations_waived:\n"
        '  - {kind: vitest_importer, path: app/src/screens/Widget.tsx, '
        f'reason: "{empty_reason}"}}\n',
    )
    write(repo, "testing/test-map.yaml", waived_map)
    base = commit(repo, "map with an empty-reason waiver")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    commit(repo, "add the component the empty-reason waiver names")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx")
    assert item is not None
    # An empty (or whitespace-only) reason is not a real waiver — it falls
    # through to the normal met/unmet evidence check, same as no waiver at
    # all, rather than silently waiving the item.
    assert item["status"] == "unmet"
    assert item["evidence"] == []
    assert "unmet_obligations" in payload["reasons"]


def test_waiver_with_reason_waives(tmp_path):
    repo = _obligations_repo(tmp_path)
    waived_map = OBLIGATIONS_TEST_MAP.replace(
        "obligations_waived: []",
        "obligations_waived:\n"
        '  - {kind: vitest_importer, path: app/src/screens/Widget.tsx, '
        'reason: "tested only through ParentScreen"}\n',
    )
    write(repo, "testing/test-map.yaml", waived_map)
    base = commit(repo, "map with a reasoned waiver")

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    commit(repo, "add the component the reasoned waiver names")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "vitest_importer", "app/src/screens/Widget.tsx")
    assert item is not None
    assert item["status"] == "waived"
    assert item["reason"] == "tested only through ParentScreen"
    assert "unmet_obligations" not in payload["reasons"]


def test_new_subparser_without_argv_evidence_is_unmet(tmp_path):
    repo = _obligations_repo(tmp_path)
    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n    sub.add_parser('widget-list', help='list widgets')\n",
    )
    base = commit(repo, "add a CLI file with one subcommand")

    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n"
        "    sub.add_parser('widget-list', help='list widgets')\n"
        "    sub.add_parser('widget-new', help='create a widget')\n",
    )
    commit(repo, "add a new subcommand with no test evidence")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "argv_evidence", "cli_widget.py", "widget-new")
    assert item is not None
    assert item["status"] == "unmet"
    assert item["evidence"] == []
    # The pre-existing subcommand is untouched — no obligation item for it.
    assert _obligation(payload, "argv_evidence", "cli_widget.py", "widget-list") is None


def test_nested_subparser_needs_adjacent_parent_child_words(tmp_path):
    repo = _obligations_repo(tmp_path)
    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n    p = sub.add_parser('widget')\n    w = p.add_subparsers()\n",
    )
    write(
        repo,
        "tests/test_cli_widget.py",
        "def test_non_adjacent():\n    argv = ['widget', 'other', 'list']\n",
    )
    base = commit(repo, "add a nested subparser action and an unrelated, non-adjacent argv test")

    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n"
        "    p = sub.add_parser('widget')\n"
        "    w = p.add_subparsers()\n"
        "    w.add_parser('list')\n",
    )
    commit(repo, "add the nested 'widget list' subcommand")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "argv_evidence", "cli_widget.py", "widget list")
    assert item is not None
    # 'widget' and 'list' appear in the test's argv, but not ADJACENT to
    # each other ('other' sits between them) — that is not evidence.
    assert item["status"] == "unmet"
    assert item["evidence"] == []


def test_new_subparser_with_argv_list_in_test_is_met(tmp_path):
    repo = _obligations_repo(tmp_path)
    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n    sub.add_parser('widget-list')\n",
    )
    base = commit(repo, "add a CLI file with one subcommand")

    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n"
        "    sub.add_parser('widget-list')\n"
        "    sub.add_parser('widget-new')\n",
    )
    write(
        repo,
        "tests/test_cli_widget.py",
        "def test_new_subcommand(monkeypatch, capsys):\n"
        "    argv = ['widget-new', '--name', 'x']\n",
    )
    commit(repo, "add the subcommand and a test asserting its argv")

    payload = run_select(repo, base=base)
    item = _obligation(payload, "argv_evidence", "cli_widget.py", "widget-new")
    assert item is not None
    assert item["status"] == "met"
    assert item["evidence"] == ["tests/test_cli_widget.py"]


def _cli_glob_obligations_repo(tmp_path):
    """`subparser_sources` as a glob, so a renamed CLI module stays a source."""
    repo = base_repo(tmp_path)
    write(
        repo,
        "testing/test-map.yaml",
        OBLIGATIONS_TEST_MAP.replace('["hub.py", "cli_widget.py"]', '["hub.py", "cli_*.py"]'),
    )
    write(
        repo,
        "cli_widget.py",
        "def register(sub):\n"
        "    p = sub.add_parser('widget')\n"
        "    w = p.add_subparsers()\n"
        "    w.add_parser('list')\n",
    )
    return repo


def test_renamed_subparser_source_raises_no_obligation(tmp_path):
    """A pure `git mv` of a CLI module declares no new subcommand; reading
    base text from the new path (absent at base) used to flag every one."""
    repo = _cli_glob_obligations_repo(tmp_path)
    base = commit(repo, "add a CLI module with nested subcommands")

    subprocess.run(["git", "mv", "cli_widget.py", "cli_gadget.py"], cwd=repo, check=True)
    commit(repo, "rename the CLI module, no content change")

    payload = run_select(repo, base=base)
    assert any(e["path"] == "cli_gadget.py" and e["status"] == "R" for e in payload["changed"])
    assert _obligations_of(payload, "argv_evidence", "cli_gadget.py") == []
    assert "unmet_obligations" not in payload["reasons"]


def test_subcommand_moved_between_subparser_sources_raises_no_obligation(tmp_path):
    repo = _cli_glob_obligations_repo(tmp_path)
    write(repo, "cli_other.py", "def register(sub):\n    sub.add_parser('other')\n")
    base = commit(repo, "two CLI modules")

    write(repo, "cli_widget.py", "def register(sub):\n    pass\n")
    write(
        repo,
        "cli_other.py",
        "def register(sub):\n"
        "    sub.add_parser('other')\n"
        "    p = sub.add_parser('widget')\n"
        "    w = p.add_subparsers()\n"
        "    w.add_parser('list')\n",
    )
    commit(repo, "move the widget subcommands into the other module")

    payload = run_select(repo, base=base)
    assert _obligations_of(payload, "argv_evidence", "cli_other.py") == []
    assert "unmet_obligations" not in payload["reasons"]


def test_renamed_subparser_source_with_a_new_subcommand_raises_only_that_one(tmp_path):
    repo = _cli_glob_obligations_repo(tmp_path)
    base = commit(repo, "add a CLI module with nested subcommands")

    subprocess.run(["git", "mv", "cli_widget.py", "cli_gadget.py"], cwd=repo, check=True)
    write(
        repo,
        "cli_gadget.py",
        "def register(sub):\n"
        "    p = sub.add_parser('widget')\n"
        "    w = p.add_subparsers()\n"
        "    w.add_parser('list')\n"
        "    w.add_parser('prune')\n",
    )
    commit(repo, "rename the CLI module and add one subcommand")

    payload = run_select(repo, base=base)
    items = _obligations_of(payload, "argv_evidence", "cli_gadget.py")
    assert [i["subcommand"] for i in items] == ["widget prune"]
    assert items[0]["status"] == "unmet"
    assert "unmet_obligations" in payload["reasons"]


def test_obligations_off_when_map_key_absent(tmp_path):
    repo = base_repo(tmp_path)  # MINIMAL_TEST_MAP has no `obligations` key
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()

    write(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    commit(repo, "add a new screen with obligations unconfigured")

    payload = run_select(repo, base=base)
    assert payload["obligations"] == []
    assert "unmet_obligations" not in payload["reasons"]


def test_unmet_obligation_sets_needs_attention_without_uncertainty_or_broaden(tmp_path):
    repo = _obligations_repo(tmp_path)
    base = commit(repo, "map with obligations configured")

    write(repo, "app/src/components/Widget.tsx", "export const Widget = () => null;\n")
    commit(repo, "add a new component with no test")

    payload = run_select(repo, base=base)
    assert payload["verdict"] == "needs_attention"
    assert "unmet_obligations" in payload["reasons"]
    assert payload["uncertainty"] == []
    for runner in ("python", "vitest", "e2e", "cargo"):
        assert payload["broaden"][runner] is None
