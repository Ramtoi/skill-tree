"""Guards for the `consumers` list every shared `tests/fixtures/*corpus*.json`
fixture declares.

A corpus fixture is a cross-language golden: two or more implementations are
asserted against the exact same cases so they cannot silently drift apart
(see `tests/AGENTS.md` and the corpus files' own `comment` keys). `consumers`
names every file that actually reads the fixture, so a reader that stops
reading it — or a new reader nobody declared — is a defect this file catches,
not a silent gap.

A "reader" is detected the same way for both directions of this check: the
fixture's file name immediately followed by a closing quote character
(`"` or `'`) in the candidate file's text. This matches a Python
`Path(...) / "name.json"` join, a JS/TS `import x from ".../name.json"`, and a
Rust `include_str!("...name.json")`-style literal, while rejecting a
markdown-style backtick mention or a sentence that merely names the file
(`... name.json.` / `` `name.json` ``) — see `tests/test_mcp_reconcile.py:725`
and `tests/test_mcp_import_corpus.py:3`, which name a corpus in a comment or
docstring without reading it.
"""

from __future__ import annotations

import glob
import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
MAP_PATH = REPO_ROOT / "testing" / "test-map.yaml"

VALID_SIDES = {"python", "typescript", "rust"}

# Files that mention a corpus file name (with a trailing quote) without
# reading it: they use the path itself as test data for the selector /
# CI-area-classifier tests, not as a corpus consumer.
NOT_CONSUMERS: dict[str, str] = {
    "tests/test_test_scope.py": "uses the fixture path as scenario data for "
    "test_scope.py's own fixture-selection tests; it does not read the corpus",
    "tests/test_ci_changed_areas.py": "uses the fixture path as scenario data "
    "for the CI changed-areas classifier tests; it does not read the corpus",
}

SCAN_GLOBS = [
    "tests/test_*.py",
    "app/src/**/*.ts",
    "app/src/**/*.tsx",
    "app/src-tauri/src/**/*.rs",
    "skill_hub/**/*.py",
]


def _corpus_files() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("*corpus*.json"))


def _load(path: Path) -> dict:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict), f"{path.name} must be a JSON object with a 'consumers' key"
    return data


def _reader_pattern(name: str) -> re.Pattern[str]:
    return re.compile(re.escape(name) + r"[\"']")


def _scan_repo_files() -> list[Path]:
    seen: set[Path] = set()
    for pattern in SCAN_GLOBS:
        for hit in glob.glob(str(REPO_ROOT / pattern), recursive=True):
            p = Path(hit)
            if "node_modules" in p.parts:
                continue
            seen.add(p)
    return sorted(seen)


@pytest.mark.parametrize("corpus_path", _corpus_files(), ids=lambda p: p.name)
def test_every_corpus_declares_consumers(corpus_path: Path):
    data = _load(corpus_path)
    consumers = data.get("consumers")
    assert isinstance(consumers, list) and consumers, (
        f"{corpus_path.name} must declare a non-empty top-level 'consumers' list"
    )
    for entry in consumers:
        assert isinstance(entry, dict), entry
        assert set(entry) == {"side", "path"}, entry
        assert entry["side"] in VALID_SIDES, f"{corpus_path.name}: bad side {entry['side']!r}"
        assert entry["path"], entry


@pytest.mark.parametrize("corpus_path", _corpus_files(), ids=lambda p: p.name)
def test_each_declared_consumer_reads_its_corpus(corpus_path: Path):
    data = _load(corpus_path)
    pattern = _reader_pattern(corpus_path.name)
    for entry in data["consumers"]:
        reader = REPO_ROOT / entry["path"]
        assert reader.is_file(), f"{corpus_path.name}: declared consumer {entry['path']} does not exist"
        text = reader.read_text(encoding="utf-8", errors="ignore")
        assert pattern.search(text), (
            f"{corpus_path.name}: declared consumer {entry['path']} does not read it "
            f"(no {corpus_path.name!r} followed by a closing quote in its text)"
        )


def test_every_reader_of_a_corpus_is_declared():
    corpora = _corpus_files()
    patterns = {p.name: _reader_pattern(p.name) for p in corpora}
    declared: dict[str, set[str]] = {}
    for p in corpora:
        data = _load(p)
        declared[p.name] = {entry["path"] for entry in data["consumers"]}

    candidates = _scan_repo_files()
    missing: list[str] = []
    for path in candidates:
        rel = str(path.relative_to(REPO_ROOT))
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for name, pattern in patterns.items():
            if rel == f"tests/fixtures/{name}":
                continue
            if not pattern.search(text):
                continue
            if rel in declared[name]:
                continue
            if rel in NOT_CONSUMERS:
                continue
            missing.append(f"{rel} reads {name} but is not declared as a consumer (and is not in NOT_CONSUMERS)")
    assert not missing, "\n".join(missing)


def test_every_reader_of_a_corpus_not_in_declared_set_is_explained():
    """Every NOT_CONSUMERS entry still matches at least one corpus name with
    a trailing quote (otherwise it is a stale exclusion nobody needs)."""
    corpora = _corpus_files()
    patterns = [(_reader_pattern(p.name), p.name) for p in corpora]
    for rel, reason in NOT_CONSUMERS.items():
        assert reason, rel
        path = REPO_ROOT / rel
        assert path.is_file(), rel
        text = path.read_text(encoding="utf-8", errors="ignore")
        assert any(pattern.search(text) for pattern, _ in patterns), (
            f"{rel} is in NOT_CONSUMERS but no longer matches any corpus name; remove the stale entry"
        )


def _expand_braces(pattern: str) -> list[str]:
    """`glob.glob` does not expand `{ts,tsx}` brace alternation; test-map.yaml's
    vitest test_glob (`app/src/**/*.test.{ts,tsx}`) uses it, so expand by hand."""
    m = re.search(r"\{([^}]+)\}", pattern)
    if not m:
        return [pattern]
    return [pattern[: m.start()] + alt + pattern[m.end() :] for alt in m.group(1).split(",")]


def _glob_matching_files(pattern: str) -> set[str]:
    matches: set[str] = set()
    for expanded in _expand_braces(pattern):
        for hit in glob.glob(str(REPO_ROOT / expanded), recursive=True):
            matches.add(str(Path(hit).relative_to(REPO_ROOT)))
    return matches


def test_each_side_has_a_runnable_test():
    test_map = yaml.safe_load(MAP_PATH.read_text(encoding="utf-8"))
    python_glob = test_map["runners"]["python"]["test_glob"]
    vitest_glob = test_map["runners"]["vitest"]["test_glob"]
    runnable_by_side = {
        "python": _glob_matching_files(python_glob),
        "typescript": _glob_matching_files(vitest_glob),
    }
    glob_label = {"python": python_glob, "typescript": vitest_glob}

    for corpus_path in _corpus_files():
        data = _load(corpus_path)
        by_side: dict[str, list[str]] = {}
        for entry in data["consumers"]:
            by_side.setdefault(entry["side"], []).append(entry["path"])
        for side, paths in by_side.items():
            if side == "rust":
                assert any(p.endswith(".rs") and "/tests" in f"/{p}" for p in paths), (
                    f"{corpus_path.name}: no rust consumer is a .rs file under a tests module: {paths}"
                )
                continue
            runnable = [p for p in paths if p in runnable_by_side[side]]
            assert runnable, (
                f"{corpus_path.name}: no {side} consumer matches the {side} runner's "
                f"test_glob {glob_label[side]!r}: {paths}"
            )
