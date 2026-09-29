#!/usr/bin/env python3
"""Plan and enforce the repository's selected/full CI contract.

The selector owns dependency discovery.  This adapter owns GitHub event policy,
safe command execution, terminal-gate decisions, and validation of reusable full
evidence.  Downloaded evidence is data only; commands always come from the
checked-out repository's freshly generated plan.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

SCHEMA_VERSION = 1
EVIDENCE_SCHEMA_VERSION = 1
WORKFLOW_ID = ".github/workflows/ci.yml"
# GitHub can take several seconds to materialize a pull request merge commit.
# Keep the planner and freshness checks on the same bounded retry contract.
SNAPSHOT_RETRY_INTERVAL_SECONDS = 2.0
SNAPSHOT_RETRY_BUDGET_SECONDS = 30.0
SNAPSHOT_RETRY_ATTEMPTS = 15
# The workflow API accepts the filename; provenance uses the full repository path.
WORKFLOW_API_ID = "ci.yml"
RUNNERS = ("python", "vitest", "e2e", "cargo", "integration")
JOB_NAMES = {
    "python": "Python",
    "vitest": "Frontend tests",
    "e2e": "Browser journeys (1/1)",
    "cargo": "Rust tests",
    "integration": "Offline contracts (Linux)",
    "frontend_static": "Frontend static",
}
REQUIRED_STEPS = {
    "Python": ["Run ruff", "Run mypy", "Run pytest"],
    "Frontend tests": ["Run vitest"],
    "Browser journeys (1/3)": ["Run Playwright journeys"],
    "Browser journeys (2/3)": ["Run Playwright journeys"],
    "Browser journeys (3/3)": ["Run Playwright journeys"],
    "Browser journeys (1/1)": ["Run Playwright journeys"],
    "Rust tests": ["Run cargo test"],
    "Offline contracts (Linux)": ["Run integration contracts"],
    "Frontend static": ["Run eslint", "Run tsc --noEmit"],
}


class CiScopeError(RuntimeError):
    pass


def select(repo: Path, base: str, head: Optional[str], worktree: bool) -> Dict[str, Any]:
    from test_scope import select as selector_select

    return selector_select(repo, base, head, worktree)


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if proc.returncode:
        raise CiScopeError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout.strip()


def changed_paths(repo: Path, base: str, sha: str) -> List[str]:
    try:
        _git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    except CiScopeError:
        # New branches and force-published snapshots may have no reachable base.
        # The selector already broadens missing-history cases to every runner.
        output = _git(repo, "ls-tree", "-r", "--name-only", sha)
    else:
        output = _git(repo, "diff", "--name-only", "--no-renames", base, sha)
    return sorted(path for path in output.splitlines() if path)


def _matches(path: str, pattern: str) -> bool:
    return fnmatch.fnmatchcase(path, pattern) or (
        pattern.endswith("/**") and (path == pattern[:-3] or path.startswith(pattern[:-2]))
    )


def is_inert(path: str) -> bool:
    # Ruff scans repository Python regardless of whether its directory is
    # documentation/report-only for test selection.
    if path.endswith(".py"):
        return False
    if _matches(path, "skills/**") or _matches(path, "testing/skills/**"):
        return False
    if path == "AGENTS.md":
        return False
    if path.endswith(".md"):
        return True
    return any(
        _matches(path, pattern)
        for pattern in (
            "testing/audits/**/report.md",
            "DESIGN-*/**",
            "docs/**",
            "openspec/**",
            "**/*.md",
            "LICENSE",
            "website/**",
        )
    )


def coarse_applicability(paths: Iterable[str]) -> Dict[str, bool]:
    result = {key: False for key in (*RUNNERS, "frontend_static")}
    for path in paths:
        if is_inert(path):
            continue
        if path.startswith("tests/fixtures/"):
            result.update(python=True, vitest=True, e2e=True, frontend_static=True)
        elif path.startswith("skills/") or path.startswith("testing/"):
            result["python"] = True
        elif path.startswith("app/src-tauri/"):
            result.update(python=True, vitest=True, e2e=True, cargo=True, frontend_static=True)
        elif path.startswith("app/"):
            result.update(vitest=True, e2e=True, frontend_static=True)
        elif path.endswith(".py") or path.startswith("tests/") or path in {
            "requirements.txt",
            "pyproject.toml",
        }:
            # Preserve the old classifier's `python` consumers: Vitest has
            # Python-spawning contracts and Rust build inputs read Python.
            result.update(python=True, vitest=True, cargo=True)
        else:
            # Workflow/config/unknown changes retain the existing fail-open policy.
            for key in result:
                if key != "integration":
                    result[key] = True
    return result


def _full_commands() -> List[Dict[str, Any]]:
    return [
        {"runner": "python", "argv": ["pytest", "tests/", "-v"], "cwd": None, "env": {}},
        {"runner": "vitest", "argv": ["npm", "run", "test", "--", "--run"], "cwd": "app", "env": {}},
        {
            "runner": "e2e",
            "argv": ["npm", "run", "test:e2e", "--"],
            "cwd": "app",
            "env": {"CI": "true"},
        },
        {
            "runner": "cargo",
            "argv": ["cargo", "test", "--locked"],
            "cwd": "app/src-tauri",
            "env": {},
        },
        {
            "runner": "integration",
            "argv": [
                "python3",
                "hub.py",
                "integration",
                "validate",
                "--profile",
                "offline",
                "--report-dir",
                "{ci_report_dir}",
            ],
            "cwd": None,
            "env": {},
        },
    ]


def _uncertainty_reasons(value: Any) -> List[str]:
    if isinstance(value, dict):
        reasons: List[str] = []
        for key, entries in value.items():
            if isinstance(entries, list):
                reasons.extend(f"{key}:{entry}" for entry in entries)
            elif entries:
                reasons.append(f"{key}:{entries}")
        return reasons
    if isinstance(value, list):
        return [str(entry) for entry in value if entry]
    return [str(value)] if value else []


def _command_runners(commands: Sequence[Mapping[str, Any]]) -> Set[str]:
    return {str(command.get("runner")) for command in commands}


def build_plan(
    repo: Path,
    *,
    event: str,
    base: str,
    sha: str,
    draft: bool,
    paths: Optional[Sequence[str]] = None,
    pr_identity: Optional[Mapping[str, str]] = None,
    workflow_config_sha: Optional[str] = None,
    workflow_source_sha: Optional[str] = None,
) -> Dict[str, Any]:
    resolved = _git(repo, "rev-parse", f"{sha}^{{commit}}")
    if resolved != sha:
        raise CiScopeError(f"planned SHA is not exact: requested {sha}, resolved {resolved}")
    paths = list(paths) if paths is not None else changed_paths(repo, base, sha)
    selector = select(repo, base, sha, False)
    mode = "selected" if event == "pull_request" and draft else "full"
    commands = list(selector.get("commands") or []) if mode == "selected" else _full_commands()
    coarse = coarse_applicability(paths)
    selected_runners = _command_runners(selector.get("commands") or [])
    broaden = selector.get("broaden") or {}
    uncertainty = _uncertainty_reasons(selector.get("uncertainty"))
    applicability = (
        dict(coarse)
        if mode == "full"
        else {key: False for key in (*RUNNERS, "frontend_static")}
    )
    for runner in RUNNERS:
        applicability[runner] = bool(
            applicability[runner]
            or runner in selected_runners
            or broaden.get(runner)
            or (runner == "cargo" and (selector.get("selections") or {}).get("cargo"))
        )
    applicability["frontend_static"] = bool(
        applicability["frontend_static"]
        or (mode == "selected" and coarse["frontend_static"])
        or applicability["vitest"]
        or applicability["e2e"]
    )
    if mode == "selected" and any(path.endswith(".py") for path in paths):
        applicability["python"] = True
    integration_profile = selector.get("integration_profile", "selected")
    # Offline is a profile obligation even if no individual case IDs appear.
    if integration_profile == "offline":
        applicability["integration"] = True
    uncertainty.extend(str(path) for path in (selector.get("unknown") or []))
    non_inert = [path for path in paths if not is_inert(path)]
    if non_inert and not any(applicability.values()):
        uncertainty = list(uncertainty) + ["non_inert_change_without_applicability"]
    if uncertainty:
        for runner in (*RUNNERS, "frontend_static"):
            applicability[runner] = True
    if event == "push":
        for runner in ("python", "vitest", "e2e", "cargo", "frontend_static"):
            applicability[runner] = True
    if mode == "full":
        command_by_runner = {command["runner"]: command for command in commands}
        # Integration remains selector-owned, including the offline profile command.
        for command in selector.get("commands") or []:
            if command.get("runner") == "integration":
                command_by_runner["integration"] = command
        commands = [
            command for runner, command in command_by_runner.items() if applicability.get(runner)
        ]
    else:
        # Coarse routing and uncertainty may establish an obligation that the
        # narrower selector command set did not include.  Fail safely by using
        # this checkout's explicit full command, never downloaded evidence.
        command_by_runner = {command["runner"]: command for command in commands}
        fallbacks = {command["runner"]: command for command in _full_commands()}
        for runner in RUNNERS:
            if applicability[runner] and runner not in command_by_runner:
                command_by_runner[runner] = fallbacks[runner]
        commands = list(command_by_runner.values())
    fingerprint = selector.get("semantic_fingerprint")
    fingerprint_valid = bool(
        isinstance(fingerprint, dict)
        and fingerprint.get("schema_version")
        and fingerprint.get("fingerprint")
        and isinstance(fingerprint.get("input_count"), int)
    )
    if not fingerprint_valid:
        # Selection can still execute safely, but the result must never be reusable.
        uncertainty = list(uncertainty) + ["semantic_fingerprint_unavailable"]
        for runner in (*RUNNERS, "frontend_static"):
            applicability[runner] = True
        command_by_runner = {command["runner"]: command for command in commands}
        for command in _full_commands():
            if command["runner"] not in command_by_runner:
                command_by_runner[command["runner"]] = command
        commands = list(command_by_runner.values())
    expected_jobs: List[str] = []
    for runner, applicable in applicability.items():
        if not applicable:
            continue
        if runner == "e2e" and mode == "full":
            expected_jobs.extend([f"Browser journeys ({shard}/3)" for shard in (1, 2, 3)])
        else:
            expected_jobs.append(JOB_NAMES[runner])
    return {
        "schema_version": SCHEMA_VERSION,
        "workflow": WORKFLOW_ID,
        "event": event,
        "base": base,
        "sha": sha,
        "mode": mode,
        "changed_paths": paths,
        "selector": selector,
        "commands": commands,
        "integration_profile": integration_profile,
        "uncertainty": uncertainty,
        "semantic_fingerprint": fingerprint if fingerprint_valid else None,
        "fingerprint_valid": fingerprint_valid,
        "applicability": applicability,
        "expected_jobs": expected_jobs,
        "e2e_shards": [1] if mode == "selected" else [1, 2, 3],
        "reuse": None,
        "pr_identity": dict(pr_identity or {}),
        "workflow_config_sha": workflow_config_sha,
        "workflow_source_sha": workflow_source_sha,
    }


def _command_for(plan: Mapping[str, Any], runner: str) -> Mapping[str, Any]:
    matches = [command for command in plan.get("commands", []) if command.get("runner") == runner]
    if len(matches) != 1:
        raise CiScopeError(f"expected exactly one {runner} command, found {len(matches)}")
    command = matches[0]
    argv = command.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
        raise CiScopeError(f"invalid argv for {runner}")
    return command


def run_planned(repo: Path, plan: Mapping[str, Any], runner: str, shard: Optional[int] = None) -> int:
    actual = _git(repo, "rev-parse", "HEAD^{commit}")
    if actual != plan.get("sha"):
        raise CiScopeError(f"checkout mismatch: planned {plan.get('sha')}, actual {actual}")
    command = _command_for(plan, runner)
    argv = list(command["argv"])
    cwd = repo / str(command["cwd"]) if command.get("cwd") else repo
    env = os.environ.copy()
    env.update({str(k): str(v) for k, v in (command.get("env") or {}).items()})
    if runner == "e2e" and plan.get("mode") == "full":
        if shard not in (1, 2, 3):
            raise CiScopeError("full e2e execution requires shard 1, 2, or 3")
        argv.append(f"--shard={shard}/3")
    if runner == "integration":
        with tempfile.TemporaryDirectory(prefix="skill-hub-ci-integration-") as temp:
            root = Path(temp)
            home = root / "home"
            report = Path(env.get("CI_REPORT_DIR", str(root / "reports")))
            userbase = root / "python-userbase"
            for path in (home, report, userbase):
                path.mkdir(parents=True)
            env.update(HOME=str(home), SKILL_HUB_HOME=str(home), PYTHONUSERBASE=str(userbase))
            rewritten: List[str] = []
            index = 0
            while index < len(argv):
                token = argv[index]
                if token == "--report-dir":
                    rewritten.extend([token, str(report)])
                    index += 2
                    continue
                rewritten.append(str(report) if token == "{ci_report_dir}" else token)
                index += 1
            if "--report-dir" not in rewritten:
                rewritten.extend(["--report-dir", str(report)])
            return subprocess.run(rewritten, cwd=cwd, env=env).returncode
    return subprocess.run(argv, cwd=cwd, env=env).returncode


def gate_decision(plan: Mapping[str, Any], outcomes: Mapping[str, str]) -> Dict[str, Any]:
    if plan.get("reuse"):
        return {"success": True, "label": "reused full evidence", "publish": False, "missing": [], "failed": []}
    expected = list(plan.get("expected_jobs") or [])
    missing = [job for job in expected if job not in outcomes]
    failed = [job for job in expected if outcomes.get(job) != "success"]
    success = not missing and not failed
    label = "full gate" if plan.get("mode") == "full" else "selected evidence"
    return {
        "success": success,
        "label": label,
        "publish": bool(success and plan.get("mode") == "full" and plan.get("fingerprint_valid")),
        "missing": missing,
        "failed": failed,
    }


def verify_current_jobs(
    expected: Sequence[str], jobs: Sequence[Mapping[str, Any]], *, run_id: int, run_attempt: int
) -> Tuple[bool, str]:
    jobs_by_name = {str(job.get("name")): job for job in jobs}
    for name in expected:
        job = jobs_by_name.get(name)
        if not job:
            return False, f"missing_job:{name}"
        if job.get("run_id") != run_id or job.get("run_attempt") != run_attempt:
            return False, f"wrong_job_identity:{name}"
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            return False, f"job_not_successful:{name}"
        steps = {str(step.get("name")): step for step in job.get("steps") or []}
        for required in REQUIRED_STEPS.get(name, []):
            step = steps.get(required)
            if not step or step.get("status") != "completed" or step.get("conclusion") != "success":
                return False, f"step_not_successful:{name}:{required}"
    return True, "accepted"


def verify_latest_jobs(
    expected: Sequence[str], jobs: Sequence[Mapping[str, Any]], *, run_id: int, run_attempt: int
) -> Tuple[bool, str, bool]:
    latest: Dict[str, Mapping[str, Any]] = {}
    for job in jobs:
        name = str(job.get("name"))
        attempt = job.get("run_attempt")
        if name not in expected or not isinstance(attempt, int) or attempt > run_attempt:
            continue
        previous = latest.get(name)
        if previous is None or int(previous.get("run_attempt", 0)) < attempt:
            latest[name] = job
    for name in expected:
        latest_job = latest.get(name)
        if not latest_job:
            return False, f"missing_job:{name}", False
        if latest_job.get("run_id") != run_id:
            return False, f"wrong_job_identity:{name}", False
        if latest_job.get("status") != "completed" or latest_job.get("conclusion") != "success":
            return False, f"job_not_successful:{name}", False
        steps = {str(step.get("name")): step for step in latest_job.get("steps") or []}
        for required in REQUIRED_STEPS.get(name, []):
            step = steps.get(required)
            if not step or step.get("status") != "completed" or step.get("conclusion") != "success":
                return False, f"step_not_successful:{name}:{required}", False
    all_current = all(latest[name].get("run_attempt") == run_attempt for name in expected)
    return True, "accepted", all_current


def expected_full_jobs(applicability: Mapping[str, bool]) -> List[str]:
    jobs: List[str] = []
    # Plans are serialized with sorted keys; evidence must not depend on
    # whether applicability is still in memory or has crossed that boundary.
    for runner, applicable in sorted(applicability.items()):
        if not applicable:
            continue
        if runner == "e2e":
            jobs.extend(f"Browser journeys ({shard}/3)" for shard in (1, 2, 3))
        else:
            jobs.append(JOB_NAMES[runner])
    return jobs


def make_evidence(
    plan: Mapping[str, Any], *, repository: str, pr: int, run_id: int, run_attempt: int, created_at: str
) -> Dict[str, Any]:
    if plan.get("mode") != "full" or plan.get("reuse") or not plan.get("fingerprint_valid"):
        raise CiScopeError("only a real successful full execution may publish evidence")
    return {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "repository": repository,
        "pr": pr,
        "workflow": WORKFLOW_ID,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "created_at": created_at,
        "semantic_fingerprint": plan["semantic_fingerprint"],
        "applicability": plan["applicability"],
        "expected_jobs": expected_full_jobs(plan["applicability"]),
        "required_steps": {
            job: REQUIRED_STEPS.get(job, []) for job in expected_full_jobs(plan["applicability"])
        },
        "executed_full": True,
        "pr_identity": plan.get("pr_identity") or {},
        "workflow_config_sha": plan.get("workflow_config_sha"),
        "workflow_source_sha": plan.get("workflow_source_sha"),
    }


def make_receipt(
    plan: Mapping[str, Any], *, repository: str, pr: int, run_id: int, run_attempt: int, created_at: str
) -> Dict[str, Any]:
    proof = plan.get("reuse")
    if proof:
        proof_identity = {"run_id": proof["run_id"], "run_attempt": proof["run_attempt"]}
    else:
        proof_identity = {"run_id": run_id, "run_attempt": run_attempt}
    return {
        "schema_version": 1,
        "repository": repository,
        "pr": pr,
        "workflow": WORKFLOW_ID,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "created_at": created_at,
        "pr_identity": plan.get("pr_identity") or {},
        "semantic_fingerprint": plan.get("semantic_fingerprint"),
        "applicability": plan.get("applicability"),
        "proof": proof_identity,
        "workflow_config_sha": plan.get("workflow_config_sha"),
        "workflow_source_sha": plan.get("workflow_source_sha"),
    }


def validate_evidence(
    evidence: Mapping[str, Any],
    *,
    repository: str,
    pr: int,
    fingerprint: Mapping[str, Any],
    applicability: Mapping[str, bool],
    api_run: Mapping[str, Any],
    api_jobs: Sequence[Mapping[str, Any]],
    now: dt.datetime,
) -> Tuple[bool, str]:
    fingerprint_identity = {
        "schema_version": fingerprint.get("schema_version"),
        "fingerprint": fingerprint.get("fingerprint"),
    }
    evidence_fingerprint = evidence.get("semantic_fingerprint")
    if not isinstance(evidence_fingerprint, Mapping) or {
        "schema_version": evidence_fingerprint.get("schema_version"),
        "fingerprint": evidence_fingerprint.get("fingerprint"),
    } != fingerprint_identity:
        return False, "wrong_semantic_fingerprint"
    required = {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "repository": repository,
        "pr": pr,
        "workflow": WORKFLOW_ID,
        "applicability": applicability,
        "executed_full": True,
    }
    for key, value in required.items():
        if evidence.get(key) != value:
            return False, f"wrong_{key}"
    identity = evidence.get("pr_identity")
    if not isinstance(identity, Mapping) or not all(
        isinstance(identity.get(key), str) and identity.get(key)
        for key in ("head_sha", "base_sha", "merge_sha")
    ):
        return False, "malformed_pr_identity"
    if not isinstance(evidence.get("workflow_config_sha"), str) or not evidence.get(
        "workflow_config_sha"
    ):
        return False, "malformed_workflow_config_sha"
    if not isinstance(evidence.get("workflow_source_sha"), str) or not evidence.get(
        "workflow_source_sha"
    ):
        return False, "malformed_workflow_source_sha"
    if api_run.get("id") != evidence.get("run_id") or api_run.get("run_attempt") != evidence.get("run_attempt"):
        return False, "wrong_run_identity"
    if api_run.get("status") != "completed" or api_run.get("conclusion") != "success":
        return False, "run_not_successful"
    if api_run.get("path") != WORKFLOW_ID or api_run.get("event") not in {
        "pull_request",
        "workflow_dispatch",
    }:
        return False, "wrong_workflow"
    if api_run.get("event") == "pull_request" and api_run.get("head_sha") != identity.get("head_sha"):
        return False, "wrong_producing_head"
    exact_jobs = expected_full_jobs(applicability)
    exact_steps = {job: REQUIRED_STEPS.get(job, []) for job in exact_jobs}
    if evidence.get("expected_jobs") != exact_jobs or evidence.get("required_steps") != exact_steps:
        return False, "incomplete_evidence_contract"
    try:
        dt.datetime.fromisoformat(str(evidence["created_at"]).replace("Z", "+00:00"))
        run_created = dt.datetime.fromisoformat(
            str(api_run.get("run_started_at") or api_run["created_at"]).replace("Z", "+00:00")
        )
    except (KeyError, TypeError, ValueError):
        return False, "malformed_created_at"
    if run_created.tzinfo is None:
        run_created = run_created.replace(tzinfo=dt.timezone.utc)
    if now - run_created > dt.timedelta(hours=24) or run_created > now + dt.timedelta(minutes=5):
        return False, "expired"
    jobs_by_name = {str(job.get("name")): job for job in api_jobs}
    for expected in evidence.get("expected_jobs") or []:
        job = jobs_by_name.get(expected)
        if not job or job.get("status") != "completed" or job.get("conclusion") != "success":
            return False, f"job_not_successful:{expected}"
        if job.get("run_id") != evidence.get("run_id") or job.get("run_attempt") != evidence.get("run_attempt"):
            return False, f"wrong_job_identity:{expected}"
        steps = {str(step.get("name")): step for step in job.get("steps") or []}
        for required_step in (evidence.get("required_steps") or {}).get(expected, []):
            step = steps.get(required_step)
            if not step or step.get("status") != "completed" or step.get("conclusion") != "success":
                return False, f"step_not_successful:{expected}:{required_step}"
    return True, "accepted"


class ActionsApi:
    def __init__(self, repository: str, token: str):
        _validate_repository_name(repository)
        self.repository = repository
        self.base = f"https://api.github.com/repos/{repository}"
        self.headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "skill-hub-ci-scope",
        }

    def get(self, path: str) -> Dict[str, Any]:
        request = urllib.request.Request(f"{self.base}{path}", headers=self.headers)
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())

    def get_repository(self, repository: str, path: str) -> Dict[str, Any]:
        _validate_repository_name(repository)
        if not path.startswith("/") or "://" in path:
            raise CiScopeError("invalid repository API path")
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repository}{path}", headers=self.headers
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())

    def bytes(self, url: str) -> bytes:
        request = urllib.request.Request(url, headers=self.headers)
        opener = urllib.request.build_opener(CrossOriginAuthStripRedirect())
        with opener.open(request, timeout=30) as response:
            return response.read()


class CrossOriginAuthStripRedirect(urllib.request.HTTPRedirectHandler):
    """Do not forward the GitHub token to an artifact blob-storage host."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: http.client.HTTPMessage,
        newurl: str,
    ) -> Optional[urllib.request.Request]:
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
            redirected.unredirected_hdrs.pop("Authorization", None)
        return redirected


def _validate_repository_name(repository: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise CiScopeError("invalid GitHub repository identity")


def workflow_blob_sha(api: ActionsApi, ref: str) -> str:
    encoded = urllib.parse.quote(ref, safe="")
    value = api.get(f"/contents/{WORKFLOW_ID}?ref={encoded}")
    sha = value.get("sha")
    if not isinstance(sha, str) or not sha:
        raise CiScopeError("workflow content identity unavailable")
    return sha


def config_provenance_matches(
    api: ActionsApi, record: Mapping[str, Any], api_run: Mapping[str, Any]
) -> bool:
    identity = record.get("pr_identity") or {}
    expected = record.get("workflow_config_sha")
    source_sha = record.get("workflow_source_sha")
    merge_sha = identity.get("merge_sha")
    if not all(isinstance(item, str) and item for item in (expected, source_sha, merge_sha)):
        return False
    if api_run.get("event") == "pull_request" and api_run.get("head_sha") != identity.get("head_sha"):
        return False
    if api_run.get("event") == "workflow_dispatch" and api_run.get("head_sha") != source_sha:
        return False
    if api_run.get("event") == "pull_request" and source_sha != api_run.get("head_sha"):
        source_commit = api.get(f"/git/commits/{source_sha}")
        source_parents = [parent.get("sha") for parent in source_commit.get("parents") or []]
        if len(source_parents) < 2 or source_parents[-1] != api_run.get("head_sha"):
            return False
    commit = api.get(f"/git/commits/{merge_sha}")
    parents = [parent.get("sha") for parent in commit.get("parents") or []]
    if parents != [identity.get("base_sha"), identity.get("head_sha")]:
        return False
    return workflow_blob_sha(api, str(source_sha)) == expected == workflow_blob_sha(api, str(merge_sha))


def _live_ref_sha(api: ActionsApi, repository: str, ref: str) -> str:
    encoded_ref = urllib.parse.quote(ref, safe="")
    value = api.get_repository(repository, f"/git/ref/heads/{encoded_ref}")
    target = value.get("object") or {}
    sha = target.get("sha")
    if (
        value.get("ref") != f"refs/heads/{ref}"
        or target.get("type") != "commit"
        or not isinstance(sha, str)
        or not sha
    ):
        raise CiScopeError("live GitHub branch ref is unavailable")
    return sha


def live_pr_identity(api: ActionsApi, pr: int, repository: str) -> Dict[str, str]:
    _validate_repository_name(repository)
    deadline = time.monotonic() + SNAPSHOT_RETRY_BUDGET_SECONDS
    diagnostics = "no snapshot response"
    for attempt in range(1, SNAPSHOT_RETRY_ATTEMPTS + 1):
        try:
            value = api.get(f"/pulls/{pr}")
        except (KeyError, OSError, TypeError, ValueError, urllib.error.URLError) as exc:
            diagnostics = f"API error={type(exc).__name__}: {exc}"
            value = None
        if value is None:
            if attempt >= SNAPSHOT_RETRY_ATTEMPTS or time.monotonic() >= deadline:
                break
            time.sleep(min(SNAPSHOT_RETRY_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic())))
            continue
        if not isinstance(value, Mapping):
            raise CiScopeError("PR repository/ref metadata is incomplete")
        merge = value.get("merge_commit_sha")
        head_metadata = value.get("head") or {}
        base_metadata = value.get("base") or {}
        head = head_metadata.get("sha")
        base = base_metadata.get("sha")
        head_ref = head_metadata.get("ref")
        base_ref = base_metadata.get("ref")
        head_repository = (head_metadata.get("repo") or {}).get("full_name")
        base_repository = (base_metadata.get("repo") or {}).get("full_name")
        metadata = (head, base, head_ref, base_ref, head_repository, base_repository)
        if not all(isinstance(item, str) and item for item in metadata):
            raise CiScopeError("PR repository/ref metadata is incomplete")
        if str(base_repository).lower() != repository.lower():
            raise CiScopeError("PR base repository does not match configured repository")
        _validate_repository_name(str(head_repository))
        if value.get("mergeable") is False or value.get("state") != "open":
            raise CiScopeError("PR is not open and mergeable with a resolved merge snapshot")
        live_base: Optional[str] = None
        live_head: Optional[str] = None
        parents: List[Any] = []
        if value.get("mergeable") is True and isinstance(merge, str) and merge:
            try:
                live_base = _live_ref_sha(api, repository, str(base_ref))
                live_head = _live_ref_sha(api, str(head_repository), str(head_ref))
                merge_commit = api.get(f"/git/commits/{merge}")
                parents = [parent.get("sha") for parent in merge_commit.get("parents") or []]
                if live_base == base and live_head == head and parents == [live_base, live_head]:
                    return {
                        "head_sha": live_head,
                        "base_sha": live_base,
                        "merge_sha": str(merge),
                    }
            except (
                AttributeError,
                CiScopeError,
                KeyError,
                OSError,
                TypeError,
                ValueError,
                urllib.error.URLError,
            ) as exc:
                diagnostics = f"{type(exc).__name__}: {exc}"
            else:
                diagnostics = (
                    f"cached base={base!r}, head={head!r}, merge={merge!r}; "
                    f"live base={live_base!r}, head={live_head!r}, "
                    f"merge parents={parents!r}"
                )
        else:
            diagnostics = (
                f"cached base={base!r}, head={head!r}, merge={merge!r}; "
                "live base/head/merge unavailable"
            )
        if attempt >= SNAPSHOT_RETRY_ATTEMPTS or time.monotonic() >= deadline:
            break
        time.sleep(min(SNAPSHOT_RETRY_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic())))
    raise CiScopeError(
        "GitHub merge snapshot has not caught up "
        f"after {attempt} attempts ({diagnostics})"
    )


def _artifact_json(
    api: ActionsApi,
    artifacts: Sequence[Mapping[str, Any]],
    name: str,
    member: str,
) -> Optional[Dict[str, Any]]:
    artifact = next((item for item in artifacts if item.get("name") == name and not item.get("expired")), None)
    if not artifact:
        return None
    data = api.bytes(str(artifact["archive_download_url"]))
    with tempfile.TemporaryDirectory(prefix="skill-hub-ci-artifact-") as temp:
        archive = Path(temp) / "artifact.zip"
        archive.write_bytes(data)
        with zipfile.ZipFile(archive) as zipped:
            if member not in zipped.namelist():
                return None
            value = json.loads(zipped.read(member))
    return value if isinstance(value, dict) else None


def find_reusable_evidence(
    api: ActionsApi,
    *,
    repository: str,
    pr: int,
    fingerprint: Mapping[str, Any],
    applicability: Mapping[str, bool],
    now: dt.datetime,
    max_runs: int = 20,
) -> Optional[Dict[str, Any]]:
    try:
        payload = api.get(
            f"/actions/workflows/{WORKFLOW_API_ID}/runs"
            f"?status=completed&per_page={max_runs}"
        )
        runs = list(payload.get("workflow_runs") or [])[:max_runs]
        for run in runs:
            run_id = run.get("id")
            attempt = run.get("run_attempt")
            jobs = api.get(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100").get("jobs") or []
            artifacts = api.get(f"/actions/runs/{run_id}/artifacts?per_page=100").get("artifacts") or []
            name = f"ci-full-evidence-{run_id}-{attempt}"
            evidence = _artifact_json(api, artifacts, name, "evidence.json")
            if not evidence:
                continue
            accepted, _ = validate_evidence(
                evidence,
                repository=repository,
                pr=pr,
                fingerprint=fingerprint,
                applicability=applicability,
                api_run=run,
                api_jobs=jobs,
                now=now,
            )
            if accepted and config_provenance_matches(api, evidence, run):
                return dict(evidence)
    except (
        AttributeError,
        CiScopeError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
        zipfile.BadZipFile,
        urllib.error.URLError,
    ):
        return None
    return None


def check_freshness(api: ActionsApi, *, repository: str, pr: int, now: dt.datetime) -> Dict[str, Any]:
    try:
        identity = live_pr_identity(api, pr, repository)
        payload = api.get(
            f"/actions/workflows/{WORKFLOW_API_ID}/runs?status=completed&per_page=20"
        )
        saw_receipt = False
        for run in list(payload.get("workflow_runs") or [])[:20]:
            run_id = run.get("id")
            attempt = run.get("run_attempt")
            artifacts = api.get(f"/actions/runs/{run_id}/artifacts?per_page=100").get("artifacts") or []
            receipt = _artifact_json(
                api,
                artifacts,
                f"ci-validation-receipt-{run_id}-{attempt}",
                "receipt.json",
            )
            if not receipt or receipt.get("repository") != repository or receipt.get("pr") != pr:
                continue
            saw_receipt = True
            if (
                receipt.get("schema_version") != 1
                or receipt.get("run_id") != run_id
                or receipt.get("run_attempt") != attempt
                or receipt.get("workflow") != WORKFLOW_ID
                or receipt.get("pr_identity") != identity
                or run.get("path") != WORKFLOW_ID
                or run.get("event") not in {"pull_request", "workflow_dispatch"}
                or not config_provenance_matches(api, receipt, run)
            ):
                continue
            receipt_jobs = api.get(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100").get("jobs") or []
            gate = next((job for job in receipt_jobs if job.get("name") == "CI gate"), None)
            if (
                run.get("status") != "completed"
                or run.get("conclusion") != "success"
                or not gate
                or gate.get("run_id") != run_id
                or gate.get("run_attempt") != attempt
                or gate.get("status") != "completed"
                or gate.get("conclusion") != "success"
            ):
                continue
            gate_steps = {str(step.get("name")): step for step in gate.get("steps") or []}
            if any(
                gate_steps.get(name, {}).get("status") != "completed"
                or gate_steps.get(name, {}).get("conclusion") != "success"
                for name in ("Verify expected outcomes", "Publish current validation receipt")
            ):
                continue
            proof = receipt.get("proof") or {}
            proof_id, proof_attempt = proof.get("run_id"), proof.get("run_attempt")
            proof_run = api.get(f"/actions/runs/{proof_id}/attempts/{proof_attempt}")
            proof_jobs = api.get(
                f"/actions/runs/{proof_id}/attempts/{proof_attempt}/jobs?per_page=100"
            ).get("jobs") or []
            proof_artifacts = api.get(f"/actions/runs/{proof_id}/artifacts?per_page=100").get("artifacts") or []
            evidence = _artifact_json(
                api,
                proof_artifacts,
                f"ci-full-evidence-{proof_id}-{proof_attempt}",
                "evidence.json",
            )
            if not evidence:
                continue
            if (
                not receipt.get("workflow_config_sha")
                or receipt.get("workflow_config_sha") != evidence.get("workflow_config_sha")
            ):
                continue
            accepted, reason = validate_evidence(
                evidence,
                repository=repository,
                pr=pr,
                fingerprint=receipt.get("semantic_fingerprint") or {},
                applicability=receipt.get("applicability") or {},
                api_run=proof_run,
                api_jobs=proof_jobs,
                now=now,
            )
            if not accepted:
                continue
            if not config_provenance_matches(api, evidence, proof_run):
                continue
            if live_pr_identity(api, pr, repository) != identity:
                return {"verdict": "stale", "reason": "pr_moved_during_check"}
            return {
                "verdict": "fresh",
                "reason": reason,
                "pr_identity": identity,
                "receipt": {"run_id": run_id, "run_attempt": attempt},
                "proof": {"run_id": proof_id, "run_attempt": proof_attempt},
            }
        return {
            "verdict": "stale" if saw_receipt else "unknown",
            "reason": "no_current_valid_receipt" if saw_receipt else "no_validation_receipt",
            "pr_identity": identity,
        }
    except (
        AttributeError,
        CiScopeError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
        zipfile.BadZipFile,
        urllib.error.URLError,
    ) as exc:
        return {"verdict": "unknown", "reason": str(exc)}


def auth_token() -> str:
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        return token
    try:
        return subprocess.check_output(
            ["gh", "auth", "token"], text=True, stderr=subprocess.DEVNULL, timeout=10
        ).strip()
    except (FileNotFoundError, subprocess.SubprocessError):
        return ""


def _load(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise CiScopeError(f"{path} must contain a JSON object")
    return value


def _write(path: Path, value: Mapping[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _append_actions_summary(markdown: str) -> None:
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        with Path(destination).open("a", encoding="utf-8") as summary:
            summary.write(markdown.rstrip() + "\n")


def plan_summary(plan: Mapping[str, Any], repository: str) -> str:
    selected = plan.get("selector", {}).get("selections", {})
    counts = []
    for runner in ("python", "vitest", "e2e", "integration"):
        value = selected.get(runner) or []
        counts.append(f"{runner}: {len(value) if isinstance(value, list) else int(bool(value))}")
    counts.append(f"cargo: {int(bool(selected.get('cargo')))}")
    required = ", ".join(plan.get("expected_jobs") or []) or "none"
    lines = [
        "## CI plan",
        f"- Mode: **{plan.get('mode', 'unknown')}**",
        f"- Planned snapshot: `{plan.get('sha', 'unknown')}`",
        f"- Required jobs: {required}",
        f"- Selected counts: {', '.join(counts)}",
    ]
    reuse = plan.get("reuse")
    if reuse:
        lines.append(
            f"- Reused full proof: [{reuse.get('run_id')}]"
            f"(https://github.com/{repository}/actions/runs/{reuse.get('run_id')})"
        )
    return "\n".join(lines) + "\n"


def gate_summary(plan: Mapping[str, Any], decision: Mapping[str, Any], repository: str) -> str:
    lines = [
        "## CI gate",
        f"- Result: **{'passed' if decision.get('success') else 'failed'}**",
        f"- Evidence: {decision.get('label', 'unknown')}",
        f"- Planned snapshot: `{plan.get('sha', 'unknown')}`",
    ]
    reuse = plan.get("reuse")
    if reuse:
        lines.append(
            f"- Original full run: [{reuse.get('run_id')}]"
            f"(https://github.com/{repository}/actions/runs/{reuse.get('run_id')})"
        )
    if decision.get("missing"):
        lines.append(f"- Missing jobs: {', '.join(decision['missing'])}")
    if decision.get("failed"):
        lines.append(f"- Failed jobs: {', '.join(decision['failed'])}")
    return "\n".join(lines) + "\n"


def cmd_plan(args: argparse.Namespace) -> int:
    identity = None
    if args.pr_head and args.pr_base and args.pr_merge:
        identity = {"head_sha": args.pr_head, "base_sha": args.pr_base, "merge_sha": args.pr_merge}
    api: Optional[ActionsApi] = None
    token = os.environ.get("GITHUB_TOKEN", "")
    if args.pr:
        if not token:
            raise CiScopeError("GitHub authentication is required to verify live PR identity")
        api = ActionsApi(args.repository, token)
        if live_pr_identity(api, args.pr, args.repository) != identity:
            raise CiScopeError("PR head, base, or merge snapshot moved before planning")
    plan = build_plan(
        args.repo,
        event=args.event,
        base=args.base,
        sha=args.sha,
        draft=args.draft,
        pr_identity=identity,
        workflow_config_sha=args.workflow_config_sha,
        workflow_source_sha=args.workflow_source_sha,
    )
    if args.reuse and plan["mode"] == "full" and plan["fingerprint_valid"] and args.pr:
        assert api is not None
        evidence = find_reusable_evidence(
            api,
            repository=args.repository,
            pr=args.pr,
            fingerprint=plan["semantic_fingerprint"],
            applicability=plan["applicability"],
            now=dt.datetime.now(dt.timezone.utc),
        )
        plan["reuse"] = evidence
    _write(args.output, plan)
    _append_actions_summary(plan_summary(plan, args.repository))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    return run_planned(args.repo, _load(args.plan), args.runner, args.shard)


def cmd_gate(args: argparse.Namespace) -> int:
    plan = _load(args.plan)
    outcomes = json.loads(args.outcomes)
    decision = gate_decision(plan, outcomes)
    api: Optional[ActionsApi] = None
    token = auth_token()
    if args.verify_live_pr:
        if not token:
            raise CiScopeError("GitHub authentication is required to verify live PR identity")
        api = ActionsApi(args.repository, token)
        if live_pr_identity(api, args.pr, args.repository) != plan.get("pr_identity"):
            raise CiScopeError("PR head, base, or merge snapshot moved during validation")
        current_run = api.get(f"/actions/runs/{args.run_id}/attempts/{args.run_attempt}")
        if not config_provenance_matches(api, plan, current_run):
            raise CiScopeError("executing workflow configuration does not match the planned merge snapshot")
    if decision["success"] and plan.get("reuse"):
        if not token:
            raise CiScopeError("GitHub authentication is required to revalidate reused evidence")
        api = api or ActionsApi(args.repository, token)
        proof = plan["reuse"]
        proof_run = api.get(f"/actions/runs/{proof['run_id']}/attempts/{proof['run_attempt']}")
        proof_jobs = api.get(
            f"/actions/runs/{proof['run_id']}/attempts/{proof['run_attempt']}/jobs?per_page=100"
        ).get("jobs") or []
        accepted, reason = validate_evidence(
            proof,
            repository=args.repository,
            pr=args.pr,
            fingerprint=plan.get("semantic_fingerprint") or {},
            applicability=plan.get("applicability") or {},
            api_run=proof_run,
            api_jobs=proof_jobs,
            now=dt.datetime.now(dt.timezone.utc),
        )
        if not accepted:
            raise CiScopeError(f"reused evidence became invalid: {reason}")
        if not config_provenance_matches(api, proof, proof_run):
            raise CiScopeError("reused evidence workflow configuration became invalid")
    if decision["success"] and not plan.get("reuse") and args.verify_api:
        if not token:
            raise CiScopeError("GITHUB_TOKEN is required to verify current jobs")
        api = api or ActionsApi(args.repository, token)
        jobs: List[Mapping[str, Any]] = []
        for attempt in range(1, args.run_attempt + 1):
            payload = api.get(f"/actions/runs/{args.run_id}/attempts/{attempt}/jobs?per_page=100")
            jobs.extend(payload.get("jobs") or [])
        verified, reason, all_current = verify_latest_jobs(
            plan.get("expected_jobs") or [],
            jobs,
            run_id=args.run_id,
            run_attempt=args.run_attempt,
        )
        if not verified:
            decision["success"] = False
            decision["publish"] = False
            decision["failed"] = list(decision["failed"]) + [reason]
        elif not all_current:
            # GitHub's "re-run failed jobs" may legitimately reuse successful
            # jobs from an earlier attempt.  It can pass readiness, but cannot
            # mint exact-attempt reusable evidence.
            decision["publish"] = False
    if decision["success"] and args.verify_live_pr:
        assert api is not None
        if live_pr_identity(api, args.pr, args.repository) != plan.get("pr_identity"):
            raise CiScopeError("PR head, base, or merge snapshot moved before receipt publication")
    print(json.dumps(decision, sort_keys=True))
    if decision["publish"]:
        evidence = make_evidence(
            plan,
            repository=args.repository,
            pr=args.pr,
            run_id=args.run_id,
            run_attempt=args.run_attempt,
            created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        )
        _write(args.evidence, evidence)
    if decision["success"] and args.receipt and (plan.get("reuse") or decision["publish"]):
        receipt = make_receipt(
            plan,
            repository=args.repository,
            pr=args.pr,
            run_id=args.run_id,
            run_attempt=args.run_attempt,
            created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        )
        _write(args.receipt, receipt)
    _append_actions_summary(gate_summary(plan, decision, args.repository))
    return 0 if decision["success"] else 1


def cmd_freshness(args: argparse.Namespace) -> int:
    token = auth_token()
    if not token:
        result = {"verdict": "unknown", "reason": "GitHub authentication unavailable"}
    else:
        result = check_freshness(
            ActionsApi(args.repository, token),
            repository=args.repository,
            pr=args.pr,
            now=dt.datetime.now(dt.timezone.utc),
        )
    print(json.dumps(result, sort_keys=True) if args.json else f"{result['verdict']}: {result['reason']}")
    return 0 if result["verdict"] == "fresh" else 1


def _accumulate_playwright_durations(
    suite: Mapping[str, Any],
    totals: Dict[str, float],
    counts: Dict[str, int],
    file_hint: str = "",
) -> None:
    """Walk one Playwright JSON-reporter suite tree (suites nest: file suite →
    describe suite → spec → test → result), summing each result's duration
    (ms) onto the spec's file. A `describe` suite has no `file` of its own, so
    the file from its nearest ancestor carries down."""
    file = suite.get("file") or file_hint
    for spec in suite.get("specs", []) or []:
        spec_file = spec.get("file") or file
        for test in spec.get("tests", []) or []:
            for result in test.get("results", []) or []:
                totals[spec_file] = totals.get(spec_file, 0.0) + float(result.get("duration", 0) or 0)
                counts[spec_file] = counts.get(spec_file, 0) + 1
    for child in suite.get("suites", []) or []:
        _accumulate_playwright_durations(child, totals, counts, file)


def e2e_durations_summary(report_paths: Sequence[Path]) -> str:
    totals: Dict[str, float] = {}
    counts: Dict[str, int] = {}
    for report_path in report_paths:
        data = _load(report_path)
        for suite in data.get("suites", []) or []:
            _accumulate_playwright_durations(suite, totals, counts)
    lines = ["## e2e durations by spec file", "", "| spec | tests | duration (s) |", "|---|---|---|"]
    for file in sorted(totals, key=lambda f: -totals[f]):
        lines.append(f"| {file} | {counts[file]} | {totals[file] / 1000:.1f} |")
    if not totals:
        lines.append("| (no results found) | 0 | 0.0 |")
    return "\n".join(lines) + "\n"


def cmd_e2e_durations(args: argparse.Namespace) -> int:
    paths = sorted({p for pattern in args.report for p in Path().glob(pattern)})
    if not paths:
        raise CiScopeError(f"no results.json files matched {args.report}")
    _append_actions_summary(e2e_durations_summary(paths))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--repo", type=Path, default=Path.cwd())
    plan.add_argument("--event", choices=["pull_request", "push"], required=True)
    plan.add_argument("--base", required=True)
    plan.add_argument("--sha", required=True)
    plan.add_argument("--draft", action="store_true")
    plan.add_argument("--reuse", action="store_true")
    plan.add_argument("--repository", default="")
    plan.add_argument("--pr", type=int, default=0)
    plan.add_argument("--pr-head")
    plan.add_argument("--pr-base")
    plan.add_argument("--pr-merge")
    plan.add_argument("--workflow-config-sha")
    plan.add_argument("--workflow-source-sha")
    plan.add_argument("--output", type=Path, required=True)
    plan.set_defaults(func=cmd_plan)
    run = sub.add_parser("run")
    run.add_argument("--repo", type=Path, default=Path.cwd())
    run.add_argument("--plan", type=Path, required=True)
    run.add_argument("--runner", choices=RUNNERS, required=True)
    run.add_argument("--shard", type=int)
    run.set_defaults(func=cmd_run)
    gate = sub.add_parser("gate")
    gate.add_argument("--plan", type=Path, required=True)
    gate.add_argument("--outcomes", required=True)
    gate.add_argument("--repository", required=True)
    gate.add_argument("--pr", type=int, required=True)
    gate.add_argument("--run-id", type=int, required=True)
    gate.add_argument("--run-attempt", type=int, required=True)
    gate.add_argument("--evidence", type=Path, default=Path("evidence.json"))
    gate.add_argument("--verify-api", action="store_true")
    gate.add_argument("--verify-live-pr", action="store_true")
    gate.add_argument("--receipt", type=Path)
    gate.set_defaults(func=cmd_gate)
    freshness = sub.add_parser("freshness")
    freshness.add_argument("--repository", required=True)
    freshness.add_argument("--pr", type=int, required=True)
    freshness.add_argument("--json", action="store_true")
    freshness.set_defaults(func=cmd_freshness)
    durations = sub.add_parser("e2e-durations")
    durations.add_argument(
        "--report",
        action="append",
        required=True,
        help="glob for one or more Playwright JSON-reporter results.json files (repeatable)",
    )
    durations.set_defaults(func=cmd_e2e_durations)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (CiScopeError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ci_scope: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
