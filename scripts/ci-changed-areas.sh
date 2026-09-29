#!/usr/bin/env bash
#
# ci-changed-areas.sh — classify a run's changed files into CI gate areas.
#
# Reads one repo-relative path per line on stdin and prints exactly three
# lines to stdout, always in this order:
#
#   frontend=<0|1>
#   python=<0|1>
#   all=<0|1>
#
# `.github/workflows/ci.yml`'s `changes` job pipes a `git diff` (or nothing,
# on a `push`) into this script and copies its stdout into $GITHUB_OUTPUT.
# Every other job gates on `needs.changes.outputs.<x> != '0'` — fail-open, so
# an unset or empty output runs the job. Empty stdin means "run everything"
# (`all=1`), same as any path this script does not recognise.
#
# Routing is first-match-wins, one `case` arm per group, in this order:
#
#   skills/*                                                 -> python (the Starter Pack lint)
#   tests/fixtures/*                                         -> frontend + python (vitest setup.ts and
#                                                               app/src/mocks import fixtures; the mocks
#                                                               back the browser journeys)
#   testing/audits/*/report.md | DESIGN-*/*                  -> inert (audit reports, design ledgers)
#   testing/*                                                -> python (the selection tool, its map,
#                                                               audit manifests; tests/test_test_scope.py
#                                                               and tests/test_testing_skills.py read them)
#   *.md | docs/* | openspec/* | LICENSE | website/*        -> inert (no-op)
#   app/src-tauri/*                                          -> all
#   app/*                                                    -> frontend
#   *.py | tests/* | requirements.txt | pyproject.toml       -> python
#   *                                                         -> all
#
# WARNING — this map is only as good as the dependency graph it encodes, and
# this repo has real tests that read across `app/src`, `app/src-tauri`, and
# the Python side. Adding or changing a test like these WITHOUT updating the
# routing above silently skips it on a green run:
#
#   - app/src/test/ipcParity.test.ts        reads app/src-tauri/src/commands/*.rs
#   - tests/test_hub_split_guard.py,
#     tests/test_plugin_boundary.py         read app/src-tauri/tauri.conf.json
#   - agent_docs.rs (cargo test)            reads tests/fixtures/agent_docs_corpus.json
#
# That is exactly why `app/src-tauri/*` routes to `all` instead of a narrower
# "rust" bucket: `pytest` and `vitest` both depend on files under it.
set -euo pipefail

FRONTEND=0
PYTHON_AREA=0
ALL=0

# Read all of stdin up front (portable across bash versions — no `mapfile`,
# which the macOS-shipped bash 3.2 lacks) so an empty diff can be told apart
# from a diff that only touched inert paths.
INPUT="$(cat)"

if [[ -z "$INPUT" ]]; then
  ALL=1
else
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      skills/*)
        # The Starter Pack ships in the bundle and pytest lints it
        # (tests/test_starter_pack_contents.py). Listed BEFORE the inert
        # rule: a SKILL.md would otherwise match `*.md` and run nothing.
        PYTHON_AREA=1
        ;;
      tests/fixtures/*)
        # vitest's setup.ts and app/src/mocks/*.ts import these JSON files,
        # and the mocks drive the Playwright journeys, so a fixture change is
        # a frontend change as well as a Python one. Listed BEFORE `tests/*`.
        FRONTEND=1
        PYTHON_AREA=1
        ;;
      testing/audits/*/report.md | DESIGN-*/*)
        : # inert — audit reports and design ledgers; no CI job reads these
        ;;
      testing/*)
        # The selection tool, its map and audit manifests are validated by
        # pytest (tests/test_test_scope.py, tests/test_testing_skills.py).
        PYTHON_AREA=1
        ;;
      *.md | docs/* | openspec/* | LICENSE | website/*)
        : # inert — no CI job reads these
        ;;
      app/src-tauri/*)
        ALL=1
        ;;
      app/*)
        FRONTEND=1
        ;;
      *.py | tests/* | requirements.txt | pyproject.toml)
        PYTHON_AREA=1
        ;;
      *)
        ALL=1
        ;;
    esac
  done <<< "$INPUT"
fi

echo "frontend=$FRONTEND"
echo "python=$PYTHON_AREA"
echo "all=$ALL"
