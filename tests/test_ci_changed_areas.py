"""Table test for `scripts/ci-changed-areas.sh` — the CI `changes` gate classifier.

Feeds the script path lists on stdin exactly as `.github/workflows/ci.yml`'s
`changes` job would (a `git diff --name-only` list, or nothing on a `push`)
and asserts the three `frontend`/`python`/`all` booleans it prints. Kept in
sync with the routing table in the script's own header comment.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "ci-changed-areas.sh"

# (paths, expected {frontend, python, all})
CASES = [
    # One row per routing arm, first-match-wins order.
    ("inert arm — doc file", ["docs/ADDING-SKILLS.md"], {"frontend": 0, "python": 0, "all": 0}),
    (
        "app/src-tauri/* arm — rust/tauri config",
        ["app/src-tauri/tauri.conf.json"],
        {"frontend": 0, "python": 0, "all": 1},
    ),
    ("app/* arm — frontend source", ["app/src/App.tsx"], {"frontend": 1, "python": 0, "all": 0}),
    ("python arm — top-level .py", ["hub.py"], {"frontend": 0, "python": 1, "all": 0}),
    ("fallback arm — unrecognised top-level file", [".gitignore"], {"frontend": 0, "python": 0, "all": 1}),
    # Individual paths named in the plan / grill.
    ("app/README.md", ["app/README.md"], {"frontend": 0, "python": 0, "all": 0}),
    ("app/src-tauri/README.md", ["app/src-tauri/README.md"], {"frontend": 0, "python": 0, "all": 0}),
    ("app/src-tauri/Cargo.lock", ["app/src-tauri/Cargo.lock"], {"frontend": 0, "python": 0, "all": 1}),
    ("app/package-lock.json", ["app/package-lock.json"], {"frontend": 1, "python": 0, "all": 0}),
    (
        "tests/fixtures/* arm — fixtures feed vitest setup and the browser mocks",
        ["tests/fixtures/agent_docs_corpus.json"],
        {"frontend": 1, "python": 1, "all": 0},
    ),
    (
        "tests/fixtures/* arm — nested usage fixture",
        ["tests/fixtures/usage/project.json"],
        {"frontend": 1, "python": 1, "all": 0},
    ),
    ("audit report is inert", ["testing/audits/2026-09-17-full/report.md"], {"frontend": 0, "python": 0, "all": 0}),
    (
        "design ledger is inert",
        ["docs/changes/DESIGN-testing-strategy/PLAN.md"],
        {"frontend": 0, "python": 0, "all": 0},
    ),
    (
        "design ledger evidence is inert",
        ["docs/changes/DESIGN-testing-strategy/evidence/x.log"],
        {"frontend": 0, "python": 0, "all": 0},
    ),
    (
        "audit manifest routes to python",
        ["testing/audits/2026-09-17-full/manifest.json"],
        {"frontend": 0, "python": 1, "all": 0},
    ),
    ("selection tool routes to python", ["testing/scripts/test_scope.py"], {"frontend": 0, "python": 1, "all": 0}),
    ("test map routes to python", ["testing/test-map.yaml"], {"frontend": 0, "python": 1, "all": 0}),
    (
        "skill under testing/ routes to python (tests/test_testing_skills.py lints it)",
        ["testing/skills/skt-testing/SKILL.md"],
        {"frontend": 0, "python": 1, "all": 0},
    ),
    (".github/workflows/ci.yml", [".github/workflows/ci.yml"], {"frontend": 0, "python": 0, "all": 1}),
    ("scripts/vendor-deps.sh", ["scripts/vendor-deps.sh"], {"frontend": 0, "python": 0, "all": 1}),
    ("website/src/index.astro", ["website/src/index.astro"], {"frontend": 0, "python": 0, "all": 0}),
    (".gitignore", [".gitignore"], {"frontend": 0, "python": 0, "all": 1}),
    (
        # The Starter Pack is bundled and pytest lints it: route to python.
        "skills/skt-mcp/SKILL.md",
        ["skills/skt-mcp/SKILL.md"],
        {"frontend": 0, "python": 1, "all": 0},
    ),
    ("hub_cli/foo.py", ["hub_cli/foo.py"], {"frontend": 0, "python": 1, "all": 0}),
    ("requirements.txt", ["requirements.txt"], {"frontend": 0, "python": 1, "all": 0}),
    ("pyproject.toml", ["pyproject.toml"], {"frontend": 0, "python": 1, "all": 0}),
    (
        # The integration catalog is a non-.py file under tests/ that still
        # matches the `tests/*` member of the python arm (line 93 of the
        # script) — the contract the integration area rests on.
        "tests/integration_contracts/catalog.json",
        ["tests/integration_contracts/catalog.json"],
        {"frontend": 0, "python": 1, "all": 0},
    ),
    # Mixed PRs.
    (
        "mixed: docs + frontend",
        ["DESIGN.md", "app/src/App.tsx"],
        {"frontend": 1, "python": 0, "all": 0},
    ),
    (
        "mixed: frontend + python",
        ["app/src/App.tsx", "hub.py"],
        {"frontend": 1, "python": 1, "all": 0},
    ),
    # Edges.
    ("empty stdin", [], {"frontend": 0, "python": 0, "all": 1}),
    (
        "docs-only list",
        ["README.md", "docs/ADDING-SKILLS.md", "openspec/changes/foo/proposal.md", "LICENSE"],
        {"frontend": 0, "python": 0, "all": 0},
    ),
]


def _run(paths: list[str]) -> str:
    result = subprocess.run(
        [str(SCRIPT)],
        input="\n".join(paths) + ("\n" if paths else ""),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def _parse(stdout: str) -> dict[str, int]:
    lines = stdout.strip("\n").split("\n")
    parsed = {}
    for line in lines:
        key, _, value = line.partition("=")
        parsed[key] = int(value)
    return parsed


@pytest.mark.parametrize("name,paths,expected", CASES, ids=[c[0] for c in CASES])
def test_routing(name, paths, expected):
    stdout = _run(paths)
    assert _parse(stdout) == expected


def test_output_is_exactly_three_lines_in_fixed_order():
    stdout = _run(["app/src/App.tsx", "hub.py", "docs/foo.md"])
    lines = stdout.strip("\n").split("\n")
    assert len(lines) == 3
    assert lines[0].startswith("frontend=")
    assert lines[1].startswith("python=")
    assert lines[2].startswith("all=")


def test_output_is_exactly_three_lines_on_empty_input():
    stdout = _run([])
    lines = stdout.strip("\n").split("\n")
    assert len(lines) == 3
    assert lines == ["frontend=0", "python=0", "all=1"]
