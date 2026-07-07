"""Permission risk pattern table — single source of truth.

`RISK_PATTERNS` enumerates the v1 risk codes. `detect_risks` runs every
pattern against a `NormalizedPermissions` and returns the findings. The
schema is emitted to `risks.generated.json` at build time (see
`app/src-tauri/build.rs`) so Python sync and (future) TypeScript frontend
read from the same table without drift.

v1 codes:
    UNBOUNDED_BASH       - allow rule matching all bash invocations
    UNBOUNDED_WRITE      - allow rule matching all writes
    UNBOUNDED_FETCH      - allow rule matching all web fetches
    UNSAFE_CODEX_COMBO   - approval_policy=never + sandbox=danger-full-access
    HOOK_RUNS_SUDO       - any hook whose command contains a sudo invocation
    CONTRADICTORY_RULE   - an allow and a deny share the same pattern (allow dead)

Adapter-raised codes (emitted at translate-time by Bash-only adapters, NOT by
`detect_risks` over a plain NormalizedPermissions — they need harness context):
    DROPPED_DENY         - a deny/ask security control skipped on a Bash-only harness
    DROPPED_HOOK         - a hook skipped on a harness with no hook target
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional


class RiskSeverity(str, Enum):
    DANGER = "danger"
    WARNING = "warning"


@dataclass
class RiskPattern:
    code: str
    severity: str
    explanation: str
    # Python-side predicate. Receives (NormalizedPermissions, capabilities-set);
    # returns a list of finding-detail strings (one per match) or [].
    predicate: Callable[..., list[str]]


@dataclass
class RiskFinding:
    code: str
    severity: str
    explanation: str
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity,
            "explanation": self.explanation,
            "detail": self.detail,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Predicates
# ─────────────────────────────────────────────────────────────────────────────


_UNBOUNDED_BASH_RE = re.compile(r"^Bash\(\*\)$|^Bash:\*$")
_UNBOUNDED_WRITE_RE = re.compile(r"^Write\(\*\)$|^Write:\*$|^Edit\(\*\)$")
_UNBOUNDED_FETCH_RE = re.compile(r"^WebFetch\(\*\)$|^WebFetch:\*$")
_SUDO_RE = re.compile(r"(?:^|[\s;|&])sudo(?:\s|$)")


def _check_unbounded(perms, regex: re.Pattern) -> list[str]:
    return [r.pattern for r in perms.allow if regex.search(r.pattern)]


def _pred_unbounded_bash(perms, capabilities=None) -> list[str]:
    return _check_unbounded(perms, _UNBOUNDED_BASH_RE)


def _pred_unbounded_write(perms, capabilities=None) -> list[str]:
    return _check_unbounded(perms, _UNBOUNDED_WRITE_RE)


def _pred_unbounded_fetch(perms, capabilities=None) -> list[str]:
    return _check_unbounded(perms, _UNBOUNDED_FETCH_RE)


def _pred_unsafe_codex_combo(perms, capabilities=None) -> list[str]:
    if perms.approval_policy == "never" and perms.sandbox_mode == "danger-full-access":
        return ["approval_policy=never + sandbox_mode=danger-full-access"]
    return []


def _pred_hook_runs_sudo(perms, capabilities=None) -> list[str]:
    return [
        f"{h.event}/{h.matcher}: {h.command}"
        for h in perms.hooks
        if _SUDO_RE.search(h.command or "")
    ]


def _pred_contradictory_rule(perms, capabilities=None) -> list[str]:
    """An allow and a deny of the SAME pattern coexist — deny wins at runtime so
    the allow is dead. Flag the pattern once per allow/deny collision."""
    deny_patterns = {r.pattern for r in perms.deny}
    return sorted({r.pattern for r in perms.allow if r.pattern in deny_patterns})


# ─────────────────────────────────────────────────────────────────────────────
# Pattern table
# ─────────────────────────────────────────────────────────────────────────────


RISK_PATTERNS: list[RiskPattern] = [
    RiskPattern(
        code="UNBOUNDED_BASH",
        severity=RiskSeverity.DANGER.value,
        explanation="Allow rule grants every Bash invocation. Narrow to specific commands (e.g. Bash(npm:*)).",
        predicate=_pred_unbounded_bash,
    ),
    RiskPattern(
        code="UNBOUNDED_WRITE",
        severity=RiskSeverity.DANGER.value,
        explanation="Allow rule grants every Write. Scope writes to specific paths.",
        predicate=_pred_unbounded_write,
    ),
    RiskPattern(
        code="UNBOUNDED_FETCH",
        severity=RiskSeverity.WARNING.value,
        explanation="Allow rule grants every WebFetch. Scope to specific domains where possible.",
        predicate=_pred_unbounded_fetch,
    ),
    RiskPattern(
        code="UNSAFE_CODEX_COMBO",
        severity=RiskSeverity.DANGER.value,
        explanation="approval_policy=never combined with sandbox_mode=danger-full-access disables every guardrail.",
        predicate=_pred_unsafe_codex_combo,
    ),
    RiskPattern(
        code="HOOK_RUNS_SUDO",
        severity=RiskSeverity.DANGER.value,
        explanation="Hook command invokes sudo. Hub-managed hooks must not require elevated privileges.",
        predicate=_pred_hook_runs_sudo,
    ),
    RiskPattern(
        code="CONTRADICTORY_RULE",
        severity=RiskSeverity.WARNING.value,
        explanation="An allow and a deny share the same pattern. Deny wins at runtime, so the allow is dead — remove one.",
        predicate=_pred_contradictory_rule,
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# Adapter-raised codes (not run by detect_risks; built by adapters at
# translate-time when a Bash-only harness drops a security control). Surfaced in
# emit_schema so the TS/Rust mirror knows their code/severity/explanation.
# ─────────────────────────────────────────────────────────────────────────────

DROPPED_DENY = RiskPattern(
    code="DROPPED_DENY",
    severity=RiskSeverity.DANGER.value,
    explanation="A deny/ask security control was dropped because this harness cannot express it — the control silently does not apply here.",
    predicate=lambda perms, capabilities=None: [],
)

DROPPED_HOOK = RiskPattern(
    code="DROPPED_HOOK",
    severity=RiskSeverity.DANGER.value,
    explanation="A hook (e.g. a security/audit PreToolUse hook) was dropped because this harness has no hook target — coverage is silently absent here.",
    predicate=lambda perms, capabilities=None: [],
)


def dropped_deny_finding(rule_pattern: str, harness_id: str, kind: str) -> "RiskFinding":
    """Build a DROPPED_DENY finding for a deny/ask rule skipped on a Bash-only harness."""
    return RiskFinding(
        code=DROPPED_DENY.code,
        severity=DROPPED_DENY.severity,
        explanation=DROPPED_DENY.explanation,
        detail=f"{harness_id}: dropped {kind} {rule_pattern}",
    )


def dropped_hook_finding(event: str, matcher: str, harness_id: str) -> "RiskFinding":
    """Build a DROPPED_HOOK finding for a hook skipped on a harness with no hook target."""
    return RiskFinding(
        code=DROPPED_HOOK.code,
        severity=DROPPED_HOOK.severity,
        explanation=DROPPED_HOOK.explanation,
        detail=f"{harness_id}: dropped hook {event}/{matcher}",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def detect_risks(perms, capabilities: Optional[set] = None) -> list[RiskFinding]:
    """Run every pattern against `perms`. Returns findings, sorted by severity then code."""
    findings: list[RiskFinding] = []
    for pat in RISK_PATTERNS:
        details = pat.predicate(perms, capabilities)
        for detail in details:
            findings.append(
                RiskFinding(
                    code=pat.code,
                    severity=pat.severity,
                    explanation=pat.explanation,
                    detail=detail,
                )
            )
    # danger before warning, then alphabetical by code+detail
    severity_rank = {"danger": 0, "warning": 1}
    findings.sort(key=lambda f: (severity_rank.get(f.severity, 99), f.code, f.detail))
    return findings


def emit_schema() -> list[dict]:
    """Serialize the risk codes for the Rust/TS mirror. Predicates are dropped.

    Includes both the `detect_risks`-evaluated `RISK_PATTERNS` and the
    adapter-raised codes (DROPPED_DENY/DROPPED_HOOK) so the UI mirror has a
    label/severity for every code the engine can emit.
    """
    all_patterns = list(RISK_PATTERNS) + [DROPPED_DENY, DROPPED_HOOK]
    return [
        {
            "code": p.code,
            "severity": p.severity,
            "explanation": p.explanation,
        }
        for p in sorted(all_patterns, key=lambda x: x.code)
    ]


def emit_schema_json() -> str:
    return json.dumps(emit_schema(), indent=2, sort_keys=True)
