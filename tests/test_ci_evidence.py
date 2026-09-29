from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "testing/scripts"))
SPEC = importlib.util.spec_from_file_location("ci_scope_evidence", REPO_ROOT / "testing/scripts/ci_scope.py")
assert SPEC and SPEC.loader
ci_scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci_scope)

NOW = dt.datetime(2026, 9, 23, 12, tzinfo=dt.timezone.utc)
FINGERPRINT = {"schema_version": 1, "fingerprint": "same", "input_count": 3, "excluded_paths": []}
APPLICABILITY = {
    "python": True,
    "vitest": False,
    "e2e": False,
    "cargo": False,
    "integration": False,
    "frontend_static": False,
}


def evidence():
    return {
        "schema_version": 1,
        "repository": "owner/repo",
        "pr": 42,
        "workflow": ".github/workflows/ci.yml",
        "run_id": 100,
        "run_attempt": 2,
        "created_at": "2026-09-23T01:00:00Z",
        "semantic_fingerprint": FINGERPRINT,
        "applicability": APPLICABILITY,
        "expected_jobs": ["Python"],
        "required_steps": {"Python": ["Run ruff", "Run mypy", "Run pytest"]},
        "executed_full": True,
        "pr_identity": {"head_sha": "head", "base_sha": "base", "merge_sha": "merge"},
        "workflow_config_sha": "workflow-blob",
        "workflow_source_sha": "head",
    }


def api_run():
    return {
        "id": 100,
        "run_attempt": 2,
        "status": "completed",
        "conclusion": "success",
        "path": ".github/workflows/ci.yml",
        "event": "pull_request",
        "created_at": "2026-09-23T01:00:00Z",
        "head_sha": "head",
    }


def api_jobs():
    return [
        {
            "name": "Python",
            "status": "completed",
            "conclusion": "success",
            "run_id": 100,
            "run_attempt": 2,
            "steps": [
                {"name": name, "status": "completed", "conclusion": "success"}
                for name in ("Run ruff", "Run mypy", "Run pytest")
            ],
        }
    ]


def validate(value, run=None, jobs=None, now=NOW):
    return ci_scope.validate_evidence(
        value,
        repository="owner/repo",
        pr=42,
        fingerprint=FINGERPRINT,
        applicability=APPLICABILITY,
        api_run=run or api_run(),
        api_jobs=jobs or api_jobs(),
        now=now,
    )


def test_exact_successful_full_evidence_is_accepted():
    assert validate(evidence()) == (True, "accepted")


def test_wrong_identity_and_attempt_are_rejected():
    for field, value in (("repository", "fork/repo"), ("pr", 43), ("workflow", "other.yml")):
        candidate = evidence()
        candidate[field] = value
        assert validate(candidate)[0] is False
    run = api_run()
    run["run_attempt"] = 3
    assert validate(evidence(), run=run) == (False, "wrong_run_identity")


def test_failed_cancelled_or_superseded_run_is_rejected():
    for conclusion in ("failure", "cancelled", "skipped"):
        run = api_run()
        run["conclusion"] = conclusion
        assert validate(evidence(), run=run)[0] is False


def test_successful_job_with_skipped_required_step_is_rejected():
    jobs = api_jobs()
    jobs[0]["steps"][-1]["conclusion"] = "skipped"
    assert validate(evidence(), jobs=jobs)[1].startswith("step_not_successful")


def test_selected_partial_and_expired_evidence_are_rejected():
    selected = evidence()
    selected["executed_full"] = False
    assert validate(selected) == (False, "wrong_executed_full")
    partial = evidence()
    partial["expected_jobs"] = ["Python", "Frontend tests"]
    assert validate(partial)[1] == "incomplete_evidence_contract"
    assert validate(evidence(), now=NOW + dt.timedelta(hours=14))[1] == "expired"


def test_artifact_cannot_omit_jobs_or_steps_and_job_identity_is_bound():
    empty = evidence()
    empty["expected_jobs"] = []
    empty["required_steps"] = {}
    assert validate(empty) == (False, "incomplete_evidence_contract")

    missing_step = evidence()
    missing_step["required_steps"] = {"Python": []}
    assert validate(missing_step) == (False, "incomplete_evidence_contract")

    jobs = api_jobs()
    jobs[0]["run_attempt"] = 1
    assert validate(evidence(), jobs=jobs) == (False, "wrong_job_identity:Python")


def test_fingerprint_diagnostics_do_not_change_semantic_identity():
    candidate = evidence()
    candidate["semantic_fingerprint"] = {
        "schema_version": 1,
        "fingerprint": "same",
        "input_count": 99,
        "excluded_paths": ["new-inert.md"],
    }
    assert validate(candidate) == (True, "accepted")


def test_reused_gate_cannot_publish_a_new_evidence_chain():
    plan = {"mode": "full", "reuse": evidence(), "fingerprint_valid": True, "expected_jobs": []}
    result = ci_scope.gate_decision(plan, {})
    assert result == {
        "success": True,
        "label": "reused full evidence",
        "publish": False,
        "missing": [],
        "failed": [],
    }


def test_reused_receipt_keeps_original_proof_identity():
    original = evidence()
    plan = {
        "reuse": original,
        "pr_identity": {"head_sha": "h2", "base_sha": "b2", "merge_sha": "m2"},
        "semantic_fingerprint": FINGERPRINT,
        "applicability": APPLICABILITY,
        "workflow_config_sha": "workflow-blob",
        "workflow_source_sha": "head",
    }
    receipt = ci_scope.make_receipt(
        plan,
        repository="owner/repo",
        pr=42,
        run_id=200,
        run_attempt=1,
        created_at="2026-09-23T12:00:00Z",
    )
    assert receipt["proof"] == {"run_id": 100, "run_attempt": 2}
    assert receipt["pr_identity"]["base_sha"] == "b2"


class PullApi:
    repository = "owner/repo"

    def __init__(self, values, *, refs=None, parents=None):
        self.values = iter(values)
        self.last_value = None
        self.pull_reads = 0
        self.refs = refs or {
            ("owner/repo", "/git/ref/heads/main"): "base",
            ("owner/repo", "/git/ref/heads/feature"): "head",
        }
        self.parents = parents or ["base", "head"]

    def get(self, path):
        if path == "/pulls/42":
            self.pull_reads += 1
            try:
                self.last_value = next(self.values)
            except StopIteration:
                if self.last_value is None:
                    raise
            return self.last_value
        if path == "/git/commits/merge":
            return {"parents": [{"sha": sha} for sha in self.parents]}
        raise AssertionError(path)

    def get_repository(self, repository, path):
        sha = self.refs.get((repository, path))
        return (
            {
                "ref": f"refs/{path.removeprefix('/git/ref/')}",
                "object": {"type": "commit", "sha": sha},
            }
            if sha
            else {}
        )


def pull(*, mergeable, head_repo="owner/repo", base_repo="owner/repo", merge="merge"):
    return {
        "state": "open",
        "mergeable": mergeable,
        "merge_commit_sha": merge,
        "head": {"sha": "head", "ref": "feature", "repo": {"full_name": head_repo}},
        "base": {"sha": "base", "ref": "main", "repo": {"full_name": base_repo}},
    }


def test_live_identity_rejects_conflict_and_pending_after_bounded_retry(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)
    with pytest.raises(ci_scope.CiScopeError, match="mergeable"):
        ci_scope.live_pr_identity(PullApi([pull(mergeable=False)]), 42, "owner/repo")
    with pytest.raises(ci_scope.CiScopeError, match="GitHub merge snapshot has not caught up"):
        ci_scope.live_pr_identity(PullApi([pull(mergeable=None)] * 3), 42, "owner/repo")


def test_live_identity_retries_pending_null_merge_until_valid(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)
    pending = pull(mergeable=None, merge=None)
    valid = pull(mergeable=True)

    assert ci_scope.live_pr_identity(PullApi([pending, valid]), 42, "owner/repo") == {
        "head_sha": "head",
        "base_sha": "base",
        "merge_sha": "merge",
    }
    with pytest.raises(ci_scope.CiScopeError, match="GitHub merge snapshot has not caught up"):
        ci_scope.live_pr_identity(PullApi([pending] * 3), 42, "owner/repo")


def test_live_identity_retries_beyond_previous_budget_until_snapshot_converges(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)
    pending = pull(mergeable=None, merge=None)
    api = PullApi([pending, pending, pending, pull(mergeable=True)])

    assert ci_scope.live_pr_identity(api, 42, "owner/repo")["merge_sha"] == "merge"
    assert api.pull_reads == 4


def test_live_identity_reports_persistent_api_error_after_bounded_retry(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)

    class ErrorApi(PullApi):
        def get(self, path):
            if path == "/pulls/42":
                self.pull_reads += 1
                raise OSError("temporary GitHub outage")
            return super().get(path)

    api = ErrorApi([])
    with pytest.raises(
        ci_scope.CiScopeError,
        match=r"after 15 attempts \(API error=OSError: temporary GitHub outage\)",
    ):
        ci_scope.live_pr_identity(api, 42, "owner/repo")
    assert api.pull_reads == 15


def test_live_identity_reports_fifteen_pending_reads_and_snapshot_diagnostics(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)
    api = PullApi([pull(mergeable=None, merge=None)])

    with pytest.raises(
        ci_scope.CiScopeError,
        match=r"after 15 attempts \(cached base='base', head='head', merge=None; live base/head/merge unavailable\)",
    ):
        ci_scope.live_pr_identity(api, 42, "owner/repo")
    assert api.pull_reads == 15


def test_live_identity_rejects_closed_pr_without_retry(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)
    closed = pull(mergeable=True)
    closed["state"] = "closed"
    api = PullApi([closed])

    with pytest.raises(ci_scope.CiScopeError, match="PR is not open"):
        ci_scope.live_pr_identity(api, 42, "owner/repo")
    assert api.pull_reads == 1


@pytest.mark.parametrize("head_repo", ["owner/repo", "contributor/fork"])
def test_live_identity_resolves_same_repository_and_fork_refs(head_repo):
    api = PullApi(
        [pull(mergeable=True, head_repo=head_repo)],
        refs={
            ("owner/repo", "/git/ref/heads/main"): "base",
            (head_repo, "/git/ref/heads/feature"): "head",
        },
    )

    assert ci_scope.live_pr_identity(api, 42, "owner/repo") == {
        "head_sha": "head",
        "base_sha": "base",
        "merge_sha": "merge",
    }


@pytest.mark.parametrize(
    ("refs", "parents"),
    [
        (
            {
                ("owner/repo", "/git/ref/heads/main"): "new-base",
                ("owner/repo", "/git/ref/heads/feature"): "head",
            },
            ["new-base", "head"],
        ),
        (
            {
                ("owner/repo", "/git/ref/heads/main"): "base",
                ("owner/repo", "/git/ref/heads/feature"): "new-head",
            },
            ["base", "new-head"],
        ),
        (
            {
                ("owner/repo", "/git/ref/heads/main"): "base",
                ("owner/repo", "/git/ref/heads/feature"): "head",
            },
            ["head", "base"],
        ),
        (
            {("owner/repo", "/git/ref/heads/feature"): "head"},
            ["base", "head"],
        ),
    ],
)
def test_live_identity_rejects_stale_or_missing_snapshot_after_three_attempts(
    monkeypatch, refs, parents
):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)
    api = PullApi([pull(mergeable=True)] * 3, refs=refs, parents=parents)

    with pytest.raises(ci_scope.CiScopeError, match="GitHub merge snapshot has not caught up"):
        ci_scope.live_pr_identity(api, 42, "owner/repo")


def test_live_identity_rejects_missing_metadata_and_wrong_base_repository():
    missing = pull(mergeable=True)
    del missing["head"]["repo"]
    with pytest.raises(ci_scope.CiScopeError, match="metadata"):
        ci_scope.live_pr_identity(PullApi([missing]), 42, "owner/repo")
    with pytest.raises(ci_scope.CiScopeError, match="base repository"):
        ci_scope.live_pr_identity(
            PullApi([pull(mergeable=True, base_repo="other/repo")]), 42, "owner/repo"
        )


def test_live_identity_retries_the_entire_snapshot_until_it_converges(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)

    class ConvergingApi(PullApi):
        def __init__(self):
            super().__init__([pull(mergeable=True)] * 2)
            self.commit_reads = 0

        def get(self, path):
            if path == "/git/commits/merge":
                self.commit_reads += 1
                parents = ["old-base", "head"] if self.commit_reads == 1 else ["base", "head"]
                return {"parents": [{"sha": sha} for sha in parents]}
            return super().get(path)

    assert ci_scope.live_pr_identity(ConvergingApi(), 42, "owner/repo")["merge_sha"] == "merge"


def test_live_identity_treats_inaccessible_head_repository_as_non_success(monkeypatch):
    monkeypatch.setattr(ci_scope.time, "sleep", lambda _: None)

    class InaccessibleForkApi(PullApi):
        def get_repository(self, repository, path):
            if repository == "contributor/fork":
                raise OSError("repository is inaccessible")
            return super().get_repository(repository, path)

    api = InaccessibleForkApi(
        [pull(mergeable=True, head_repo="contributor/fork")] * 3,
        refs={("owner/repo", "/git/ref/heads/main"): "base"},
    )
    with pytest.raises(ci_scope.CiScopeError, match="GitHub merge snapshot has not caught up"):
        ci_scope.live_pr_identity(api, 42, "owner/repo")


def test_repository_scoped_api_rejects_metadata_urls():
    api = ci_scope.ActionsApi("owner/repo", "token")
    with pytest.raises(ci_scope.CiScopeError, match="repository identity"):
        api.get_repository("https://example.test/attacker", "/git/ref/heads/main")
    with pytest.raises(ci_scope.CiScopeError, match="API path"):
        api.get_repository("owner/repo", "https://example.test/ref")


def test_planning_rechecks_live_identity_before_building_plan(monkeypatch):
    api = PullApi([pull(mergeable=True)])
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(ci_scope, "ActionsApi", lambda repository, token: api)
    monkeypatch.setattr(
        ci_scope,
        "build_plan",
        lambda *args, **kwargs: pytest.fail("plan was built before live identity validation"),
    )
    args = SimpleNamespace(
        pr_head="old-head",
        pr_base="old-base",
        pr_merge="old-merge",
        pr=42,
        repository="owner/repo",
    )

    with pytest.raises(ci_scope.CiScopeError, match="moved before planning"):
        ci_scope.cmd_plan(args)


def test_cross_origin_artifact_redirect_strips_authorization():
    handler = ci_scope.CrossOriginAuthStripRedirect()
    request = urllib.request.Request(
        "https://api.github.com/artifact", headers={"Authorization": "Bearer secret"}
    )
    redirected = handler.redirect_request(
        request, None, 302, "Found", {}, "https://objects.example.test/signed"
    )
    assert redirected is not None
    assert redirected.get_header("Authorization") is None


def test_artifact_json_reads_only_named_json_member():
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("receipt.json", json.dumps({"pr": 42}))

    class Api:
        def bytes(self, url):
            assert url == "https://api/artifact"
            return payload.getvalue()

    value = ci_scope._artifact_json(
        Api(),
        [{"name": "receipt", "expired": False, "archive_download_url": "https://api/artifact"}],
        "receipt",
        "receipt.json",
    )
    assert value == {"pr": 42}


class FreshApi:
    repository = "owner/repo"

    def __init__(self, identities, *, proof_created="2026-09-23T01:00:00Z"):
        self.identities = iter(identities)
        self.proof_created = proof_created
        self.current_identity = IDENTITY

    def get(self, path):
        if path == "/pulls/42":
            identity = next(self.identities)
            self.current_identity = identity
            return {
                "state": "open",
                "mergeable": True,
                "head": {
                    "sha": identity["head_sha"],
                    "ref": "feature",
                    "repo": {"full_name": "owner/repo"},
                },
                "base": {
                    "sha": identity["base_sha"],
                    "ref": "main",
                    "repo": {"full_name": "owner/repo"},
                },
                "merge_commit_sha": identity["merge_sha"],
            }
        if path.startswith("/actions/workflows/"):
            assert path.startswith("/actions/workflows/ci.yml/runs?")
            return {
                "workflow_runs": [
                    {
                        "id": 200,
                        "run_attempt": 1,
                        "status": "completed",
                        "conclusion": "success",
                        "path": ".github/workflows/ci.yml",
                        "event": "pull_request",
                        "head_sha": "head",
                    }
                ]
            }
        if path == "/actions/runs/200/artifacts?per_page=100":
            return {"artifacts": [{"name": "receipt"}]}
        if path == "/actions/runs/200/attempts/1/jobs?per_page=100":
            return {
                "jobs": [
                    {
                        "name": "CI gate",
                        "run_id": 200,
                        "run_attempt": 1,
                        "status": "completed",
                        "conclusion": "success",
                        "steps": [
                            {"name": name, "status": "completed", "conclusion": "success"}
                            for name in (
                                "Verify expected outcomes",
                                "Publish current validation receipt",
                            )
                        ],
                    }
                ]
            }
        if path == "/actions/runs/100/attempts/2":
            run = api_run()
            run["created_at"] = self.proof_created
            return run
        if path == "/actions/runs/100/attempts/2/jobs?per_page=100":
            return {"jobs": api_jobs()}
        if path == "/actions/runs/100/artifacts?per_page=100":
            return {"artifacts": [{"name": "proof"}]}
        if path.startswith("/contents/.github/workflows/ci.yml?ref="):
            return {"sha": "workflow-blob"}
        if path == "/git/commits/merge":
            return {
                "parents": [
                    {"sha": self.current_identity["base_sha"]},
                    {"sha": self.current_identity["head_sha"]},
                ]
            }
        raise AssertionError(path)

    def get_repository(self, repository, path):
        assert repository == "owner/repo"
        sha = (
            self.current_identity["base_sha"]
            if path == "/git/ref/heads/main"
            else self.current_identity["head_sha"]
        )
        return {
            "ref": f"refs/{path.removeprefix('/git/ref/')}",
            "object": {"type": "commit", "sha": sha},
        }


IDENTITY = {"head_sha": "head", "base_sha": "base", "merge_sha": "merge"}


def receipt(identity=IDENTITY, config="workflow-blob"):
    return {
        "schema_version": 1,
        "repository": "owner/repo",
        "pr": 42,
        "workflow": ".github/workflows/ci.yml",
        "run_id": 200,
        "run_attempt": 1,
        "pr_identity": identity,
        "semantic_fingerprint": FINGERPRINT,
        "applicability": APPLICABILITY,
        "proof": {"run_id": 100, "run_attempt": 2},
        "workflow_config_sha": config,
        "workflow_source_sha": "head",
    }


def test_freshness_validates_current_receipt_and_original_proof(monkeypatch):
    proof = evidence()
    proof["workflow_config_sha"] = "workflow-blob"
    monkeypatch.setattr(
        ci_scope,
        "_artifact_json",
        lambda api, artifacts, name, member: receipt() if member == "receipt.json" else proof,
    )
    result = ci_scope.check_freshness(
        FreshApi([IDENTITY, IDENTITY]), repository="owner/repo", pr=42, now=NOW
    )
    assert result["verdict"] == "fresh"
    assert result["proof"] == {"run_id": 100, "run_attempt": 2}


def test_freshness_rejects_receipt_claiming_another_run(monkeypatch):
    proof = evidence()
    bad = receipt()
    bad.update(schema_version=999, run_id=999, run_attempt=999)
    monkeypatch.setattr(
        ci_scope,
        "_artifact_json",
        lambda api, artifacts, name, member: bad if member == "receipt.json" else proof,
    )
    result = ci_scope.check_freshness(
        FreshApi([IDENTITY]), repository="owner/repo", pr=42, now=NOW
    )
    assert result["verdict"] == "stale"


@pytest.mark.parametrize("case", ["changed-base", "config", "expired", "moved-second-read"])
def test_freshness_rejects_stale_stack_provenance(monkeypatch, case):
    proof = evidence()
    proof["workflow_config_sha"] = "workflow-blob"
    current = dict(IDENTITY)
    stored = dict(IDENTITY)
    identities = [current, current]
    api = FreshApi(identities)
    stored_config = "workflow-blob"
    if case == "changed-base":
        stored["base_sha"] = "old-base"
    elif case == "config":
        stored_config = "old-workflow"
    elif case == "expired":
        api = FreshApi(identities, proof_created="2026-09-21T01:00:00Z")
    else:
        moved = dict(current)
        moved["head_sha"] = "new-head"
        api = FreshApi([current, moved])
    monkeypatch.setattr(
        ci_scope,
        "_artifact_json",
        lambda api, artifacts, name, member: (
            receipt(stored, stored_config) if member == "receipt.json" else proof
        ),
    )
    result = ci_scope.check_freshness(api, repository="owner/repo", pr=42, now=NOW)
    assert result["verdict"] == "stale"


def test_dispatch_full_proof_is_discoverable_without_pull_request_run_filter(monkeypatch):
    proof = evidence()

    class Api:
        def get(self, path):
            if path.startswith("/actions/workflows/"):
                assert path.startswith("/actions/workflows/ci.yml/runs?")
                assert "event=pull_request" not in path
                run = api_run()
                run.update(id=100, run_attempt=2, pull_requests=[], event="workflow_dispatch")
                return {"workflow_runs": [run]}
            if "jobs" in path:
                return {"jobs": api_jobs()}
            if "artifacts" in path:
                return {"artifacts": [{"name": "proof"}]}
            if path.startswith("/contents/.github/workflows/ci.yml?ref="):
                return {"sha": "workflow-blob"}
            if path == "/git/commits/merge":
                return {"parents": [{"sha": "base"}, {"sha": "head"}]}
            raise AssertionError(path)

    monkeypatch.setattr(ci_scope, "_artifact_json", lambda *args: proof)
    found = ci_scope.find_reusable_evidence(
        Api(),
        repository="owner/repo",
        pr=42,
        fingerprint=FINGERPRINT,
        applicability=APPLICABILITY,
        now=NOW,
    )
    assert found == proof


@pytest.mark.parametrize("source_head, expected", [("head", True), ("unrelated", False)])
def test_pr_workflow_source_merge_must_share_the_pr_head(source_head, expected):
    record = evidence()
    record["pr_identity"] = {"head_sha": "head", "base_sha": "new-base", "merge_sha": "new-merge"}
    record["workflow_source_sha"] = "source-merge"
    run = api_run()

    class Api:
        def get(self, path):
            if path == "/git/commits/source-merge":
                return {"parents": [{"sha": "old-base"}, {"sha": source_head}]}
            if path == "/git/commits/new-merge":
                return {"parents": [{"sha": "new-base"}, {"sha": "head"}]}
            if path.startswith("/contents/.github/workflows/ci.yml?ref="):
                return {"sha": "workflow-blob"}
            raise AssertionError(path)

    assert ci_scope.config_provenance_matches(Api(), record, run) is expected


def test_full_evidence_accepts_applicability_after_sorted_json_round_trip():
    applicability = {**APPLICABILITY, "cargo": True}
    serialized = json.loads(json.dumps(applicability, sort_keys=True))
    value = evidence()
    value["applicability"] = serialized
    value["expected_jobs"] = ci_scope.expected_full_jobs(serialized)
    value["required_steps"] = {
        job: ci_scope.REQUIRED_STEPS[job] for job in value["expected_jobs"]
    }
    jobs = api_jobs() + [{
        "name": "Rust tests", "status": "completed", "conclusion": "success",
        "run_id": 100, "run_attempt": 2,
        "steps": [{"name": "Run cargo test", "status": "completed", "conclusion": "success"}],
    }]
    accepted, reason = ci_scope.validate_evidence(
        value, repository="owner/repo", pr=42, fingerprint=FINGERPRINT,
        applicability=applicability, api_run=api_run(), api_jobs=jobs, now=NOW,
    )
    assert accepted, reason
    assert ci_scope.expected_full_jobs(applicability) == value["expected_jobs"]
    assert set(value["expected_jobs"]) == {"Python", "Rust tests"}
