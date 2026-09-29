from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "testing/scripts"))
SPEC = importlib.util.spec_from_file_location("ci_scope", REPO_ROOT / "testing/scripts/ci_scope.py")
assert SPEC and SPEC.loader
ci_scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci_scope)


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def repository(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "ci@example.test")
    git(repo, "config", "user.name", "CI")
    (repo / "README.md").write_text("base\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "base")
    return repo, git(repo, "rev-parse", "HEAD")


def selector(*, commands=None, profile="selected", uncertainty=None):
    return {
        "commands": commands or [],
        "selections": {"python": [], "vitest": [], "e2e": [], "cargo": False, "integration": []},
        "broaden": {},
        "uncertainty": uncertainty or [],
        "integration_profile": profile,
        "semantic_fingerprint": {
            "schema_version": 1,
            "fingerprint": "abc",
            "input_count": 4,
            "excluded_paths": ["README.md"],
        },
    }


def commit(repo: Path, path: str, content: str) -> str:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    git(repo, "add", path)
    git(repo, "commit", "-qm", path)
    return git(repo, "rev-parse", "HEAD")


def test_draft_consumes_selector_commands_and_ready_is_full(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "skill_hub/example.py", "VALUE = 1\n")
    selected = selector(
        commands=[
            {
                "runner": "python",
                "argv": ["python3", "-m", "pytest", "tests/test_example.py", "-q"],
                "cwd": None,
                "env": {},
            }
        ]
    )
    monkeypatch.setattr(ci_scope, "select", lambda *args: selected)

    draft = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    ready = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=False)

    assert draft["mode"] == "selected"
    assert draft["commands"][0] == selected["commands"][0]
    assert {command["runner"] for command in draft["commands"]} == {"python"}
    assert draft["expected_jobs"] == ["Python"]
    assert ready["mode"] == "full"
    assert [command["runner"] for command in ready["commands"]] == ["python", "vitest", "cargo"]
    assert ready["e2e_shards"] == [1, 2, 3]


def test_main_is_full_even_when_called_draft(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "skill_hub/example.py", "VALUE = 1\n")
    monkeypatch.setattr(ci_scope, "select", lambda *args: selector())
    plan = ci_scope.build_plan(repo, event="push", base=base, sha=sha, draft=True)
    assert plan["mode"] == "full"
    assert plan["reuse"] is None
    assert all(
        plan["applicability"][runner]
        for runner in ("python", "vitest", "e2e", "cargo", "frontend_static")
    )
    assert {command["runner"] for command in plan["commands"]} == {
        "python",
        "vitest",
        "e2e",
        "cargo",
    }


def test_empty_uncertainty_dict_does_not_broaden(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "README.md", "inert\n")
    chosen = selector()
    chosen["uncertainty"] = {"python": [], "vitest": [], "paths": []}
    monkeypatch.setattr(ci_scope, "select", lambda *args: chosen)
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    assert not any(plan["applicability"].values())


def test_unmet_obligations_do_not_widen_draft_applicability(tmp_path, monkeypatch):
    """TA-1-obligations: `compute_obligations` deliberately never adds to
    `uncertainty` — an unmet obligation is a local_test_runner-only gate
    (parent decision 2). `build_plan` only widens draft applicability from
    `selector["uncertainty"]`, so an unmet item sitting in
    `selector["obligations"]` alone must leave applicability exactly as
    narrow as the selector's own commands, not fan out to every runner."""
    repo, base = repository(tmp_path)
    sha = commit(repo, "app/src/screens/Widget.tsx", "export const Widget = () => null;\n")
    chosen = selector(
        commands=[
            {
                "runner": "vitest",
                "argv": ["npx", "vitest", "run", "src/test/Widget.test.tsx"],
                "cwd": None,
                "env": {},
            }
        ]
    )
    chosen["obligations"] = [
        {
            "kind": "vitest_importer",
            "path": "app/src/screens/Widget.tsx",
            "status": "unmet",
            "evidence": [],
            "reason": "no vitest test file imports this new component directly",
        }
    ]
    chosen["verdict"] = "needs_attention"
    chosen["reasons"] = ["unmet_obligations"]
    monkeypatch.setattr(ci_scope, "select", lambda *args: chosen)

    draft = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)

    assert draft["mode"] == "selected"
    assert draft["uncertainty"] == []
    assert draft["applicability"]["python"] is False
    assert draft["applicability"]["e2e"] is False
    assert draft["applicability"]["cargo"] is False
    assert draft["applicability"]["vitest"] is True
    assert {command["runner"] for command in draft["commands"]} == {"vitest"}


@pytest.mark.parametrize("path", ["docs/helper.py", "DESIGN-probe/helper.py"])
def test_python_under_report_only_directories_still_gets_static_validation(tmp_path, monkeypatch, path):
    repo, base = repository(tmp_path)
    sha = commit(repo, path, "undefined_name\n")
    monkeypatch.setattr(ci_scope, "select", lambda *args: selector())
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    assert plan["applicability"]["python"] is True
    assert "Python" in plan["expected_jobs"]


def test_python_static_obligation_survives_an_unrelated_vitest_selection(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    commit(repo, "docs/helper.py", "undefined_name\n")
    sha = commit(repo, "app/src/test/example.test.ts", "export {}\n")
    chosen = selector(
        commands=[
            {
                "runner": "vitest",
                "argv": ["npx", "vitest", "run", "src/test/example.test.ts"],
                "cwd": "app",
                "env": {},
            }
        ]
    )
    monkeypatch.setattr(ci_scope, "select", lambda *args: chosen)
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    assert plan["applicability"]["python"] is True
    assert plan["applicability"]["vitest"] is True
    assert plan["applicability"]["e2e"] is False
    assert plan["applicability"]["cargo"] is False
    assert {command["runner"] for command in plan["commands"]} == {"python", "vitest"}


def test_cross_reader_selector_expands_full_applicability(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "AGENTS.md", "runtime input\n")
    chosen = selector(
        commands=[
            {
                "runner": "vitest",
                "argv": ["npx", "vitest", "run", "src/test/runtime.test.ts"],
                "cwd": "app",
                "env": {},
            }
        ]
    )
    monkeypatch.setattr(ci_scope, "select", lambda *args: chosen)
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=False)
    assert plan["applicability"]["vitest"] is True
    assert plan["applicability"]["frontend_static"] is True


def test_vitest_only_draft_does_not_run_e2e(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "app/src/test/example.test.ts", "export {}\n")
    chosen = selector(
        commands=[
            {
                "runner": "vitest",
                "argv": ["npx", "vitest", "run", "src/test/example.test.ts"],
                "cwd": "app",
                "env": {},
            }
        ]
    )
    monkeypatch.setattr(ci_scope, "select", lambda *args: chosen)
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    assert plan["applicability"]["vitest"] is True
    assert plan["applicability"]["frontend_static"] is True
    assert plan["applicability"]["e2e"] is False
    assert {command["runner"] for command in plan["commands"]} == {"vitest"}


def test_python_test_only_draft_does_not_run_cargo_or_vitest(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "tests/test_example.py", "def test_example(): assert True\n")
    chosen = selector(
        commands=[
            {
                "runner": "python",
                "argv": ["python3", "-m", "pytest", "tests/test_example.py", "-q"],
                "cwd": None,
                "env": {},
            }
        ]
    )
    monkeypatch.setattr(ci_scope, "select", lambda *args: chosen)
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    assert plan["applicability"]["python"] is True
    assert plan["applicability"]["vitest"] is False
    assert plan["applicability"]["cargo"] is False
    assert {command["runner"] for command in plan["commands"]} == {"python"}


def test_offline_profile_requires_integration_with_empty_case_list(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "tests/integration_contracts/catalog.json", "{}\n")
    monkeypatch.setattr(ci_scope, "select", lambda *args: selector(profile="offline"))
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=True)
    assert plan["applicability"]["integration"] is True
    assert "Offline contracts (Linux)" in plan["expected_jobs"]


def test_missing_fingerprint_fails_safe_and_cannot_publish(tmp_path, monkeypatch):
    repo, base = repository(tmp_path)
    sha = commit(repo, "skill_hub/example.py", "VALUE = 1\n")
    broken = selector()
    broken.pop("semantic_fingerprint")
    monkeypatch.setattr(ci_scope, "select", lambda *args: broken)
    plan = ci_scope.build_plan(repo, event="pull_request", base=base, sha=sha, draft=False)
    assert all(plan["applicability"].values())
    assert plan["fingerprint_valid"] is False
    outcomes = {job: "success" for job in plan["expected_jobs"]}
    assert ci_scope.gate_decision(plan, outcomes)["publish"] is False


def test_gate_rejects_missing_failed_skipped_and_cancelled_jobs():
    plan = {"mode": "full", "expected_jobs": ["Python", "Frontend tests"], "fingerprint_valid": True, "reuse": None}
    assert ci_scope.gate_decision(plan, {"Python": "success"})["success"] is False
    for outcome in ("failure", "skipped", "cancelled"):
        result = ci_scope.gate_decision(plan, {"Python": "success", "Frontend tests": outcome})
        assert result["success"] is False


def test_current_execution_requires_each_matrix_member_and_required_step():
    expected = ["Browser journeys (1/3)", "Browser journeys (2/3)", "Browser journeys (3/3)"]
    jobs = [
        {
            "name": name,
            "run_id": 9,
            "run_attempt": 2,
            "status": "completed",
            "conclusion": "success",
            "steps": [
                {"name": "Run Playwright journeys", "status": "completed", "conclusion": "success"}
            ],
        }
        for name in expected
    ]
    assert ci_scope.verify_current_jobs(expected, jobs, run_id=9, run_attempt=2) == (True, "accepted")
    assert ci_scope.verify_current_jobs(expected, jobs[:2], run_id=9, run_attempt=2) == (
        False,
        "missing_job:Browser journeys (3/3)",
    )
    jobs[2]["steps"][0]["conclusion"] = "skipped"
    assert ci_scope.verify_current_jobs(expected, jobs, run_id=9, run_attempt=2)[0] is False


def test_failed_jobs_rerun_can_use_prior_success_but_not_publish_evidence():
    expected = ["Python", "Frontend tests"]
    jobs = [
        {
            "name": name,
            "run_id": 9,
            "run_attempt": attempt,
            "status": "completed",
            "conclusion": "success",
            "steps": [
                {"name": step, "status": "completed", "conclusion": "success"}
                for step in ci_scope.REQUIRED_STEPS[name]
            ],
        }
        for name, attempt in (("Python", 1), ("Frontend tests", 2))
    ]
    assert ci_scope.verify_latest_jobs(expected, jobs, run_id=9, run_attempt=2) == (
        True,
        "accepted",
        False,
    )


def test_run_rejects_checkout_other_than_planned_sha(tmp_path):
    repo, base = repository(tmp_path)
    sha = commit(repo, "a.py", "print('a')\n")
    plan = {
        "sha": base,
        "mode": "selected",
        "commands": [{"runner": "python", "argv": ["python3", "-V"], "cwd": None, "env": {}}],
    }
    with pytest.raises(ci_scope.CiScopeError, match="checkout mismatch"):
        ci_scope.run_planned(repo, plan, "python")


def test_actions_summaries_make_mode_reuse_and_failures_visible(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    plan = {
        "mode": "full",
        "sha": "abc123",
        "expected_jobs": ["Python"],
        "selector": {
            "selections": {
                "python": ["tests/test_one.py"],
                "vitest": [],
                "e2e": [],
                "integration": [],
                "cargo": False,
            }
        },
        "reuse": {"run_id": 77},
    }
    decision = {
        "success": False,
        "label": "reused full evidence",
        "missing": ["Python"],
        "failed": ["Frontend tests"],
    }
    ci_scope._append_actions_summary(ci_scope.plan_summary(plan, "owner/repo"))
    ci_scope._append_actions_summary(ci_scope.gate_summary(plan, decision, "owner/repo"))
    rendered = summary.read_text(encoding="utf-8")
    assert "Mode: **full**" in rendered
    assert "Planned snapshot: `abc123`" in rendered
    assert "https://github.com/owner/repo/actions/runs/77" in rendered
    assert "python: 1" in rendered
    assert "Missing jobs: Python" in rendered
    assert "Failed jobs: Frontend tests" in rendered


def _playwright_results(specs: list[dict]) -> dict:
    return {"suites": [{"suites": [{"specs": specs}]}]}


def test_e2e_durations_summary_sums_by_spec_file(tmp_path):
    report = tmp_path / "results.json"
    report.write_text(
        __import__("json").dumps(
            _playwright_results(
                [
                    {
                        "file": "e2e/screen-geometry.journey.spec.ts",
                        "tests": [
                            {"results": [{"duration": 1500}]},
                            {"results": [{"duration": 2500}]},
                        ],
                    },
                    {
                        "file": "e2e/library-search.journey.spec.ts",
                        "tests": [{"results": [{"duration": 4000}]}],
                    },
                ]
            )
        ),
        encoding="utf-8",
    )
    rendered = ci_scope.e2e_durations_summary([report])
    assert "e2e/screen-geometry.journey.spec.ts | 2 | 4.0" in rendered
    assert "e2e/library-search.journey.spec.ts | 1 | 4.0" in rendered


def test_e2e_durations_summary_sums_across_multiple_report_files(tmp_path):
    shard1 = tmp_path / "shard1.json"
    shard2 = tmp_path / "shard2.json"
    shard1.write_text(
        __import__("json").dumps(
            _playwright_results([{"file": "e2e/a.journey.spec.ts", "tests": [{"results": [{"duration": 1000}]}]}])
        ),
        encoding="utf-8",
    )
    shard2.write_text(
        __import__("json").dumps(
            _playwright_results([{"file": "e2e/a.journey.spec.ts", "tests": [{"results": [{"duration": 2000}]}]}])
        ),
        encoding="utf-8",
    )
    rendered = ci_scope.e2e_durations_summary([shard1, shard2])
    assert "e2e/a.journey.spec.ts | 2 | 3.0" in rendered


def test_e2e_durations_summary_with_no_results_says_so(tmp_path):
    report = tmp_path / "results.json"
    report.write_text(__import__("json").dumps({"suites": []}), encoding="utf-8")
    rendered = ci_scope.e2e_durations_summary([report])
    assert "no results found" in rendered


def test_cmd_e2e_durations_writes_to_step_summary(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    report = tmp_path / "e2e-durations-1" / "results.json"
    report.parent.mkdir(parents=True)
    report.write_text(
        __import__("json").dumps(
            _playwright_results([{"file": "e2e/a.journey.spec.ts", "tests": [{"results": [{"duration": 1000}]}]}])
        ),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    args = ci_scope.build_parser().parse_args(["e2e-durations", "--report", "e2e-durations-*/results.json"])
    assert ci_scope.cmd_e2e_durations(args) == 0
    assert "e2e/a.journey.spec.ts" in summary.read_text(encoding="utf-8")


def test_cmd_e2e_durations_raises_when_nothing_matches(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    args = ci_scope.build_parser().parse_args(["e2e-durations", "--report", "e2e-durations-*/results.json"])
    with pytest.raises(ci_scope.CiScopeError, match="no results.json files matched"):
        ci_scope.cmd_e2e_durations(args)


@pytest.mark.parametrize("base", ["0" * 40, "f" * 40])
def test_unavailable_push_base_includes_every_snapshot_path(tmp_path, base):
    repo, _ = repository(tmp_path)
    sha = commit(repo, "skill_hub/example.py", "VALUE = 1\n")
    assert ci_scope.changed_paths(repo, base, sha) == ["README.md", "skill_hub/example.py"]
