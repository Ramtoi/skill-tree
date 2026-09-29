"""Structural contracts for selected/full CI orchestration."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CI_PATH = REPO_ROOT / ".github/workflows/ci.yml"
INTEGRATION_PATH = REPO_ROOT / ".github/workflows/integration-validation.yml"

# The nightly workflow is stripped from the public snapshot (.gitattributes
# export-ignore), so the tests that read it skip there.
needs_nightly_workflow = pytest.mark.skipif(
    not INTEGRATION_PATH.exists(),
    reason="integration-validation.yml is not shipped in the public snapshot",
)


def load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def run_resolver_script(config):
    if shutil.which("node") is None:
        pytest.skip("node is required for the extracted resolver contract")
    script = load(CI_PATH)["jobs"]["plan"]["steps"][0]["with"]["script"]
    wrapper = """
const config = JSON.parse(process.env.RESOLVER_CONFIG);
const outputs = {};
const failures = [];
const infos = [];
const calls = {pulls: 0, refs: 0, commits: 0, content: 0};
let fakeNow = 0;
const clockStep = config.clockStep || 0;
Date.now = () => { fakeNow += clockStep; return fakeNow; };
globalThis.setTimeout = (callback, _delay) => { callback(); return 0; };
const pullSequence = config.pullSequence || [];
const headRepository = config.headRepository || 'owner/repo';
const workflowSha = config.workflowSha || 'workflow-blob';
const github = {
  rest: {
    pulls: {
      get: async () => {
        const raw = pullSequence[Math.min(calls.pulls++, pullSequence.length - 1)];
        return {data: {
          state: raw.state || 'open',
          mergeable: raw.mergeable,
          merge_commit_sha: raw.merge === undefined ? 'merge' : raw.merge,
          draft: Boolean(raw.draft),
          head: {sha: raw.head || 'head', ref: 'feature', repo: {full_name: headRepository}},
          base: {sha: raw.base || 'base', ref: 'main', repo: {full_name: 'owner/repo'}},
        }};
      },
    },
    git: {
      getRef: async ({owner, repo, ref}) => {
        calls.refs += 1;
        const branch = ref.replace(/^heads\\//, '');
        const sha = branch === 'main' ? (config.liveBase || 'base') : (config.liveHead || 'head');
        return {data: {ref: `refs/heads/${branch}`, object: {type: 'commit', sha}}};
      },
      getCommit: async () => {
        calls.commits += 1;
        const parents = config.parents || ['base', 'head'];
        return {data: {parents: parents.map((sha) => ({sha}))}};
      },
    },
    repos: {
      getContent: async () => {
        calls.content += 1;
        return {data: {sha: workflowSha}};
      },
    },
  },
};
const core = {
  setOutput: (name, value) => { outputs[name] = String(value); },
  setFailed: (message) => { failures.push(String(message)); },
  info: (message) => { infos.push(String(message)); },
};
const context = {
  eventName: 'pull_request',
  payload: {pull_request: {number: 42}},
  repo: {owner: 'owner', repo: 'repo'},
};
async function resolve() {
""" + script + """
}
resolve().then(() => console.log(JSON.stringify({outputs, failures, infos, calls})))
  .catch((error) => { console.error(error.stack || error); process.exit(1); });
"""
    environment = os.environ.copy()
    environment.update({"RESOLVER_CONFIG": json.dumps(config), "WORKFLOW_SOURCE_SHA": "source-sha"})
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=wrapper,
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def on(workflow):
    return workflow[True]


def test_pull_requests_have_all_state_events_and_no_path_filter():
    pull_request = on(load(CI_PATH))["pull_request"]
    assert set(pull_request["types"]) == {
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "converted_to_draft",
        "edited",
    }
    assert "paths" not in pull_request
    assert on(load(CI_PATH))["workflow_dispatch"]["inputs"]["pr_number"]["required"] is True


def test_paid_runner_is_default_and_ci_has_no_spectre_routing():
    workflow = load(CI_PATH)
    assert all(job["runs-on"] == "ubicloud-standard-2" for job in workflow["jobs"].values())
    assert "spectrebox" not in CI_PATH.read_text(encoding="utf-8").lower()


def test_plan_drives_selected_one_shard_and_full_three_shards():
    workflow = load(CI_PATH)
    browser = workflow["jobs"]["browser-journeys"]
    assert browser["strategy"]["matrix"]["shard"] == "${{ fromJSON(needs.plan.outputs.e2e_shards) }}"
    assert "e2e_total" in browser["name"]
    run = next(step for step in browser["steps"] if step.get("name") == "Run Playwright journeys")
    assert "needs.plan.outputs.mode == 'full'" in run["run"]


def test_every_checkout_is_pinned_to_the_planned_snapshot():
    workflow = load(CI_PATH)
    for job_name, job in workflow["jobs"].items():
        checkouts = [step for step in job.get("steps", []) if step.get("uses") == "actions/checkout@v5"]
        assert len(checkouts) == 1, job_name
        expected = (
            "${{ steps.resolve.outputs.merge }}" if job_name == "plan" else "${{ needs.plan.outputs.sha }}"
        )
        assert checkouts[0]["with"]["ref"] == expected


def test_consumers_download_only_the_current_plan_artifact():
    workflow = load(CI_PATH)
    for job_name, job in workflow["jobs"].items():
        if job_name == "plan":
            continue
        download = next(step for step in job["steps"] if step.get("uses") == "actions/download-artifact@v4")
        assert download["with"]["name"] == "${{ needs.plan.outputs.artifact }}"
        checkout_index = next(i for i, step in enumerate(job["steps"]) if step.get("uses") == "actions/checkout@v5")
        download_index = next(
            i for i, step in enumerate(job["steps"]) if step.get("uses") == "actions/download-artifact@v4"
        )
        assert checkout_index < download_index


def test_terminal_gate_is_always_run_and_verifies_live_api_jobs():
    workflow = load(CI_PATH)
    gate = workflow["jobs"]["ci-gate"]
    assert "'CI gate'" in gate["name"]
    assert "always()" in gate["if"]
    assert set(gate["needs"]) == {
        "plan",
        "python",
        "vitest",
        "browser-journeys",
        "frontend-static",
        "cargo-test",
        "integration",
    }
    verify = next(step for step in gate["steps"] if step.get("name") == "Verify expected outcomes")
    assert "--verify-api" in verify["run"]
    assert "github.run_attempt" in verify["run"]
    assert "--verify-live-pr" in verify["run"]


def test_dispatch_binds_executing_workflow_blob_to_pr_merge_snapshot():
    script = load(CI_PATH)["jobs"]["plan"]["steps"][0]["with"]["script"]
    assert "context.payload.inputs.pr_number" in script
    assert "pull.mergeable === true" in script
    assert "workflowAtRun.data.sha !== workflowAtMerge.data.sha" in script
    assert "pull.merge_commit_sha" in script


def test_initial_resolver_uses_live_fork_aware_refs_and_ordered_merge_parents():
    script = load(CI_PATH)["jobs"]["plan"]["steps"][0]["with"]["script"]
    assert "pull.base?.repo?.full_name" in script
    assert "pull.head?.repo?.full_name" in script
    assert "github.rest.git.getRef" in script
    assert "github.rest.git.getCommit" in script
    assert "parents[0].sha === liveBase" in script
    assert "parents[1].sha === liveHead" in script
    assert "GitHub merge snapshot has not caught up" in script


def test_initial_resolver_retries_for_bounded_propagation_window_with_diagnostics():
    script = load(CI_PATH)["jobs"]["plan"]["steps"][0]["with"]["script"]
    assert "const retryBudgetMs = 30_000" in script
    assert "const maxAttempts = 15" in script
    assert "cached base=${cachedBase}, head=${cachedHead}, merge=${merge}" in script
    assert "after ${completedAttempts} attempts; ${diagnostics}" in script


def test_extracted_resolver_accepts_immediate_success_and_publishes_draft_provenance():
    result = run_resolver_script(
        {"pullSequence": [{"mergeable": True, "draft": True}]}
    )

    assert result["failures"] == []
    assert result["outputs"] == {
        "pr": "42",
        "head": "head",
        "base": "base",
        "merge": "merge",
        "draft": "true",
        "workflow_sha": "workflow-blob",
        "workflow_source_sha": "source-sha",
    }
    assert result["calls"] == {"pulls": 1, "refs": 2, "commits": 1, "content": 2}


def test_extracted_resolver_retries_past_three_polls_until_merge_snapshot_exists():
    result = run_resolver_script(
        {
            "pullSequence": [
                {"mergeable": None, "merge": None},
                {"mergeable": None, "merge": None},
                {"mergeable": None, "merge": None},
                {"mergeable": True},
            ]
        }
    )

    assert result["failures"] == []
    assert result["outputs"]["merge"] == "merge"
    assert result["calls"]["pulls"] == 4


def test_extracted_resolver_reports_fifteen_pending_polls_and_diagnostics():
    result = run_resolver_script({"pullSequence": [{"mergeable": None, "merge": None}]})

    assert result["calls"]["pulls"] == 15
    assert result["failures"] == [
        "GitHub merge snapshot has not caught up after 15 attempts; "
        "cached base=base, head=head, merge=unavailable; live base/head/merge unavailable"
    ]


def test_extracted_resolver_honors_deadline_before_attempt_budget():
    result = run_resolver_script(
        {"pullSequence": [{"mergeable": None, "merge": None}], "clockStep": 1000}
    )

    attempts = result["calls"]["pulls"]
    assert 0 < attempts < 15
    assert result["failures"] == [
        f"GitHub merge snapshot has not caught up after {attempts} attempts; "
        "cached base=base, head=head, merge=unavailable; live base/head/merge unavailable"
    ]


def test_metadata_only_edits_do_not_displace_or_start_validation_work():
    workflow = load(CI_PATH)
    concurrency = workflow["concurrency"]
    plan = workflow["jobs"]["plan"]
    gate = workflow["jobs"]["ci-gate"]

    assert "github.event.action == 'edited'" in concurrency["group"]
    assert "!github.event.changes.base" in concurrency["group"]
    assert "github.run_id" in concurrency["group"]
    assert "!github.event.changes.base" in concurrency["cancel-in-progress"]
    assert "!github.event.changes.base" in plan["if"]
    assert "'Metadata edit ignored'" in gate["name"]
    assert "!github.event.changes.base" in gate["if"]


def test_base_edits_and_plan_failures_keep_the_normal_terminal_gate():
    workflow = load(CI_PATH)
    gate = workflow["jobs"]["ci-gate"]

    assert "always()" in gate["if"]
    assert "github.event.changes.base" in workflow["jobs"]["plan"]["if"]
    assert "github.event.changes.base" in gate["if"]


def test_planner_failure_fails_gate_without_consuming_missing_plan_outputs():
    workflow = load(CI_PATH)
    steps = workflow["jobs"]["ci-gate"]["steps"]
    failure = steps[0]
    assert failure["name"] == "Fail clearly when planning fails"
    assert failure["if"] == "${{ needs.plan.result != 'success' }}"
    checkout = next(step for step in steps if step.get("uses") == "actions/checkout@v5")
    download = next(step for step in steps if step.get("uses") == "actions/download-artifact@v4")
    verify = next(step for step in steps if step.get("name") == "Verify expected outcomes")
    for step in (checkout, download, verify):
        assert step["if"] == "${{ needs.plan.result == 'success' }}"
    assert "no plan artifact exists" in failure["run"]


def test_flaky_report_steps_are_advisory_and_not_required():
    """The flaky-ledger report steps (vitest and browser-journeys jobs) must
    never gate CI: `always()` so they still run after a real failure,
    `continue-on-error: true` so a reporter bug cannot fail the job, and
    absent from `ci_scope.REQUIRED_STEPS` so `ci-gate`'s step-name
    verification never expects them."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("ci_scope_for_test", REPO_ROOT / "testing/scripts/ci_scope.py")
    assert spec and spec.loader
    ci_scope = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ci_scope)

    workflow = load(CI_PATH)
    vitest_report = next(
        step for step in workflow["jobs"]["vitest"]["steps"] if step.get("name") == "Report flaky tests"
    )
    browser_report = next(
        step for step in workflow["jobs"]["browser-journeys"]["steps"] if step.get("name") == "Report flaky tests"
    )
    for step in (vitest_report, browser_report):
        assert step["if"] == "always()"
        assert step["continue-on-error"] is True

    for job_name, required in ci_scope.REQUIRED_STEPS.items():
        assert "Report flaky tests" not in required, job_name


def test_flaky_vitest_artifact_upload_is_advisory():
    workflow = load(CI_PATH)
    upload = next(
        step for step in workflow["jobs"]["vitest"]["steps"] if step.get("name") == "Upload flaky vitest report"
    )
    assert upload["if"] == "always()"
    assert upload["continue-on-error"] is True
    assert upload["with"]["name"] == "flaky-vitest-${{ github.run_attempt }}"
    assert upload["with"]["if-no-files-found"] == "ignore"


def test_playwright_and_vitest_retries_gate_on_github_actions_not_ci():
    playwright_config = (REPO_ROOT / "app" / "playwright.config.ts").read_text(encoding="utf-8")
    vitest_config = (REPO_ROOT / "app" / "vitest.config.ts").read_text(encoding="utf-8")
    assert 'process.env.GITHUB_ACTIONS === "true" ? 1 : 0' in playwright_config
    assert 'process.env.GITHUB_ACTIONS === "true" ? 1 : 0' in vitest_config
    # local_test_runner.py sets CI=true locally; retries must not key on it.
    assert "retries: process.env.CI ?" not in playwright_config
    assert "retry: process.env.CI ?" not in vitest_config


def test_static_and_test_jobs_share_the_immutable_plan():
    workflow = load(CI_PATH)
    plan_outputs = workflow["jobs"]["plan"]["outputs"]
    assert {"python", "vitest", "e2e", "cargo", "integration", "frontend_static"} <= set(plan_outputs)
    for job in ("python", "vitest", "browser-journeys", "frontend-static", "cargo-test", "integration"):
        assert "needs.plan.outputs.reuse != 'true'" in workflow["jobs"][job]["if"]


@needs_nightly_workflow
def test_nightly_workflow_has_no_pr_trigger_and_keeps_three_operating_systems():
    workflow = load(INTEGRATION_PATH)
    triggers = on(workflow)
    assert "pull_request" not in triggers
    assert {"schedule", "workflow_dispatch"} <= set(triggers)
    includes = workflow["jobs"]["offline"]["strategy"]["matrix"]["include"]
    assert {entry["os"] for entry in includes} == {"Linux", "macOS", "Windows"}
    assert all(
        step.get("with", {}).get("ref") == "${{ github.sha }}"
        for step in workflow["jobs"]["offline"]["steps"]
        if step.get("uses") == "actions/checkout@v5"
    )


@needs_nightly_workflow
def test_spectrebox_is_explicit_nightly_linux_opt_in_with_paid_fallback():
    workflow = load(INTEGRATION_PATH)
    runner = workflow["jobs"]["runner"]
    assert runner["runs-on"] == "ubicloud-standard-2"
    step = runner["steps"][0]
    assert step["env"]["OPT_IN"] == "${{ vars.CI_NIGHTLY_SPECTREBOX }}"
    assert "process.env.OPT_IN === 'true'" in step["with"]["script"]
    assert "destination = 'ubicloud-standard-2'" in step["with"]["script"]
    assert "listSelfHostedRunnersForRepo" in step["with"]["script"]
