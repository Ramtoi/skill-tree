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
                           (scanned over BOTH permission-block hooks in
                           `detect_risks` AND the hook library's resolved hooks in
                           `detect_hook_risks`)
    CONTRADICTORY_RULE   - an allow and a deny share the same pattern (allow dead)

Adapter-raised codes (emitted at translate-time by Bash-only adapters, NOT by
`detect_risks` over a plain NormalizedPermissions — they need harness context):
    DROPPED_DENY         - a deny/ask security control skipped on a Bash-only harness

Hook-library codes (raised by `detect_hook_risks` over resolved hooks — they need
hook + harness-capability context, so they are NOT run by `detect_risks`):
    HOOK_BROKEN_SCRIPT      - a hook command references a script path absent on disk
    LSP_CHECKER_MISSING     - a configured lsp-report checker binary is not on PATH
    LSP_INTERPRETER_MISSING - the lsp-report hook's baked interpreter path is gone

Hook-script code (raised by `detect_hook_script_risks` over the registry hook
library — it needs registry + project context, so it is NOT run by either
`detect_risks` or `detect_hook_risks`):
    HOOK_SCRIPT_MISSING     - a managed script body is gone, or a repo script is
                              absent in ≥1 attached project

Backup codes (raised by `detect_backup_risks` over the registry `backup:` block —
they need registry context, so they are NOT run by `detect_risks`):
    BACKUP_STALE            - repeated push failures, or a restore still holding
                              every push while awaiting acknowledgement
    BACKUP_AUTH_EXPIRED     - the last push failed for an auth reason

Companion codes (raised by `detect_companion_risks` over the `ships_with`
ownership ledger `projects.<n>.companions` — they need registry context, so
they are NOT run by `detect_risks`):
    COMPANION_ORPHANED      - a ledger entry's skill is no longer active on the
                              project (--keep-companions, or a bundle-only
                              equip — bundles never provision companions), or
                              a ledger item is absent from the skill's CURRENT
                              ships_with declaration (an upstream drop)
    COMPANIONS_PENDING      - an active ships_with skill has no ledger entry
                              (reached via a bundle, or an equipped-via-refs
                              skill-only companion)
    COMPANION_REF_MISSING   - a `ships_with` hook declared as `{ref: <name>}`
                              names a hooks-library definition that no longer
                              exists (fed from `ships_with_reconcile.classify`)
    COMPANION_AGENT_DRIFT   - a companion agent's rendered file on disk no
                              longer matches the hash the ledger recorded —
                              hand-edited outside the skill; never clobbered
                              (fed from `ships_with_reconcile.classify`)

Retired: `DROPPED_HOOK` ("Codex has no hooks") — codex IS hook-capable and hooks
are no longer authored from the permissions block (hooks-surface D3/D6).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from skill_hub.domain.hooks.hooks_model import ResolvedHook
    from skill_hub.infrastructure.harnesses.harness_probe import HookCapability


class RiskSeverity(str, Enum):
    DANGER = "danger"
    WARNING = "warning"
    INFO = "info"


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

_HOOK_SUDO_EXPLANATION = (
    "Hook command invokes sudo. Hub-managed hooks must not require elevated "
    "privileges."
)


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
        explanation=_HOOK_SUDO_EXPLANATION,
        predicate=_pred_hook_runs_sudo,
    ),
    RiskPattern(
        code="CONTRADICTORY_RULE",
        severity=RiskSeverity.WARNING.value,
        explanation="An allow and a deny share the same pattern. Deny wins at runtime, so the allow is dead — remove one.",  # noqa: E501
        predicate=_pred_contradictory_rule,
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# Native-file conflict findings (permissions-divergence-fixes). These read the
# harness's ACTUAL settings content (adapter.discover_existing), so they see
# user-authored rules — the perms-predicate table above only ever sees hub's
# registry view. None of them mutates anything; the duplicates / blanket rules
# they flag are the user's to keep.
# ─────────────────────────────────────────────────────────────────────────────


_BLANKET_RULE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\((?:\*|\*\*)\)$")
_NARROW_RULE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$")

DUPLICATE_NATIVE_RULES = RiskPattern(
    code="DUPLICATE_NATIVE_RULES",
    severity=RiskSeverity.WARNING.value,
    explanation="A native settings file lists the same rule more than once — usually append-without-dedupe accumulation. Harmless at runtime, but it hides what is actually in force.",  # noqa: E501
    predicate=lambda *_: [],
)

ASK_SHADOWS_ALLOW = RiskPattern(
    code="ASK_SHADOWS_ALLOW",
    severity=RiskSeverity.WARNING.value,
    explanation="The same pattern is in both ask and allow. Claude-family harnesses evaluate deny, then ask, then allow — so sessions PROMPT for this pattern despite the allow.",  # noqa: E501
    predicate=lambda *_: [],
)

BLANKET_ALLOW_SHADOWS = RiskPattern(
    code="BLANKET_ALLOW_SHADOWS",
    severity=RiskSeverity.INFO.value,
    explanation="A blanket allow (e.g. Bash(*)) coexists with narrower rules for the same tool — the narrow rules are decorative. If the blanket is deliberate, this is fine; hub never removes it.",  # noqa: E501
    predicate=lambda *_: [],
)

SIDECAR_INDEX_DRIFT = RiskPattern(
    code="SIDECAR_INDEX_DRIFT",
    severity=RiskSeverity.WARNING.value,
    explanation="The last sync found hub-managed rules at different positions than the ownership sidecar recorded — the native file was edited outside hub. Hub removed only its own values (verified), but review the file.",  # noqa: E501
    predicate=lambda *_: [],
)


def detect_native_conflicts(
    discovered, registry_perms=None, source_file: str = ""
) -> list["RiskFinding"]:
    """Conflict findings over a native file's ACTUAL content.

    `discovered` is the adapter's `discover_existing()` view (user-authored +
    hub-managed rules alike). `registry_perms` is hub's intent for the same
    scope — used only to suppress ASK_SHADOWS_ALLOW when the registry itself
    declares the ask (intent matches outcome, nothing to warn about).
    """
    findings: list[RiskFinding] = []
    loc = f" in {source_file}" if source_file else ""

    # Duplicates: same pattern more than once within one kind's list.
    for kind, rules in (
        ("allow", discovered.allow),
        ("deny", discovered.deny),
        ("ask", discovered.ask),
    ):
        counts: dict[str, int] = {}
        for r in rules:
            counts[r.pattern] = counts.get(r.pattern, 0) + 1
        for pattern in sorted(p for p, n in counts.items() if n > 1):
            findings.append(RiskFinding(
                code=DUPLICATE_NATIVE_RULES.code,
                severity=DUPLICATE_NATIVE_RULES.severity,
                explanation=DUPLICATE_NATIVE_RULES.explanation,
                detail=f"{pattern} appears {counts[pattern]}x in {kind}{loc}",
            ))

    # Ask shadows allow: prompts despite the allow (deny > ask > allow).
    registry_asks = (
        {r.pattern for r in registry_perms.ask} if registry_perms is not None else set()
    )
    allow_patterns = {r.pattern for r in discovered.allow}
    if registry_perms is not None:
        allow_patterns |= {r.pattern for r in registry_perms.allow}
    for pattern in sorted({r.pattern for r in discovered.ask} & allow_patterns):
        if pattern in registry_asks:
            continue  # the registry wants the ask — intent matches outcome
        findings.append(RiskFinding(
            code=ASK_SHADOWS_ALLOW.code,
            severity=ASK_SHADOWS_ALLOW.severity,
            explanation=ASK_SHADOWS_ALLOW.explanation,
            detail=f"{pattern} is both ask and allow{loc} — sessions will prompt",
        ))

    # Blanket allow beside narrower same-tool allow rules.
    blanket_tools = set()
    for r in discovered.allow:
        m = _BLANKET_RULE_RE.match(r.pattern)
        if m:
            blanket_tools.add(m.group(1))
    for tool in sorted(blanket_tools):
        narrower = sorted({
            r.pattern
            for r in discovered.allow
            if (m := _NARROW_RULE_RE.match(r.pattern))
            and m.group(1) == tool
            and not _BLANKET_RULE_RE.match(r.pattern)
        })
        if narrower:
            shown = ", ".join(narrower[:4]) + ("…" if len(narrower) > 4 else "")
            findings.append(RiskFinding(
                code=BLANKET_ALLOW_SHADOWS.code,
                severity=BLANKET_ALLOW_SHADOWS.severity,
                explanation=BLANKET_ALLOW_SHADOWS.explanation,
                detail=f"{tool}(*) shadows {len(narrower)} narrower allow rule(s) ({shown}){loc}",  # noqa: E501
            ))
    return findings


def detect_sidecar_drift(sidecar_state) -> list["RiskFinding"]:
    """SIDECAR_INDEX_DRIFT findings from the drift log the last apply recorded
    in a v2 sidecar. `missing` events (the user deleted hub's rule; nothing was
    removed) are deliberately not findings — the next sync re-asserts the rule."""
    if sidecar_state is None:
        return []
    events = [
        ev
        for ev in getattr(sidecar_state, "drift_events", []) or []
        if isinstance(ev, dict) and ev.get("mode") == "fallback"
    ]
    if not events:
        return []
    shown = ", ".join(str(ev.get("expected")) for ev in events[:4])
    if len(events) > 4:
        shown += "…"
    return [RiskFinding(
        code=SIDECAR_INDEX_DRIFT.code,
        severity=SIDECAR_INDEX_DRIFT.severity,
        explanation=SIDECAR_INDEX_DRIFT.explanation,
        detail=f"{len(events)} rule(s) moved in {sidecar_state.file}: {shown}",
    )]


# ─────────────────────────────────────────────────────────────────────────────
# Adapter-raised codes (not run by detect_risks; built by adapters at
# translate-time when a Bash-only harness drops a security control). Surfaced in
# emit_schema so the TS/Rust mirror knows their code/severity/explanation.
#
# NOTE: `DROPPED_HOOK` ("Codex has no hooks") was RETIRED (hooks-surface D3/D6):
# codex is hook-capable and hooks are no longer authored from the permissions
# block, so no adapter drops a permission-block hook anymore.
# ─────────────────────────────────────────────────────────────────────────────

DROPPED_DENY = RiskPattern(
    code="DROPPED_DENY",
    severity=RiskSeverity.DANGER.value,
    explanation="A deny/ask security control was dropped because this harness cannot express it — the control silently does not apply here.",  # noqa: E501
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


# ─────────────────────────────────────────────────────────────────────────────
# Hook-library codes (raised by `detect_hook_risks` over resolved hooks — they
# need hook + harness-capability context). Declared here so `emit_schema` ships
# their code/severity/explanation to the TS/Rust mirror; the predicate is a no-op
# because these are built by the detector, not run over a NormalizedPermissions.
# ─────────────────────────────────────────────────────────────────────────────

HOOK_BROKEN_SCRIPT = RiskPattern(
    code="HOOK_BROKEN_SCRIPT",
    severity=RiskSeverity.WARNING.value,
    explanation="A hook command references a script path that does not exist on disk — the hook will fail to run.",
    predicate=lambda perms, capabilities=None: [],
)

LSP_CHECKER_MISSING = RiskPattern(
    code="LSP_CHECKER_MISSING",
    severity=RiskSeverity.INFO.value,
    explanation="A language is enabled for the lsp-report hook but its checker binary is not on PATH — that language is a silent runtime no-op.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

HOOK_SCRIPT_MISSING = RiskPattern(
    code="HOOK_SCRIPT_MISSING",
    severity=RiskSeverity.WARNING.value,
    explanation="A hook's script file is missing — a managed body was deleted outside Skill Tree, or a repo script does not exist in a project the hook is attached to.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

LSP_INTERPRETER_MISSING = RiskPattern(
    code="LSP_INTERPRETER_MISSING",
    severity=RiskSeverity.WARNING.value,
    explanation="The lsp-report hook's baked interpreter path no longer exists on disk — the hook will fail to run at all until the next sync re-bakes it.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

# ─────────────────────────────────────────────────────────────────────────────
# Companion codes (raised by `detect_companion_risks` over the `ships_with`
# ownership ledger `projects.<n>.companions` — it needs registry context, so it
# is NOT run by `detect_risks`). Declared here so `emit_schema` ships their
# code/severity/explanation to the TS/Rust mirror; the predicate is a no-op
# because these are built by the detector, not run over a NormalizedPermissions.
# ─────────────────────────────────────────────────────────────────────────────

COMPANION_ORPHANED = RiskPattern(
    code="COMPANION_ORPHANED",
    severity=RiskSeverity.WARNING.value,
    explanation="A project's companion ledger references a skill that is no longer active, or an item its skill's ships_with block no longer declares. Companions provisioned earlier were left in place — remove them explicitly or re-provision.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

COMPANIONS_PENDING = RiskPattern(
    code="COMPANIONS_PENDING",
    severity=RiskSeverity.INFO.value,
    explanation="A skill with a ships_with block is active on a project — via a bundle, or equipped alongside a referenced skill — with no companion ledger entry: its guardrails were never offered for consent.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

COMPANION_REF_MISSING = RiskPattern(
    code="COMPANION_REF_MISSING",
    severity=RiskSeverity.WARNING.value,
    explanation="A ships_with hook references a hooks-library definition that no longer exists. Re-add the library entry or edit the skill's companions to drop the reference.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

COMPANION_AGENT_DRIFT = RiskPattern(
    code="COMPANION_AGENT_DRIFT",
    severity=RiskSeverity.WARNING.value,
    explanation="A companion agent's rendered file no longer matches the hash the ledger recorded — it was hand-edited outside the skill. Nothing was clobbered; resolve with `hub skill companions resolve --op keep-mine|keep-skill`.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

# ─────────────────────────────────────────────────────────────────────────────
# Backup codes (raised by `detect_backup_risks` over the registry `backup:`
# block — they need registry context, so they are NOT run by `detect_risks`).
#
# A backup that has quietly stopped working is the most expensive silent failure
# in the product: nothing is broken until the day the disk dies. The pass is
# fail-OPEN by design, so the counters it leaves behind are the only trace, and
# without a doctor finding they scroll past as one yellow line per sync.
# ─────────────────────────────────────────────────────────────────────────────

BACKUP_STALE = RiskPattern(
    code="BACKUP_STALE",
    severity=RiskSeverity.WARNING.value,
    explanation="The cloud copy of the backup is not current — pushes have been failing, or a restore is still awaiting acknowledgement. Local snapshots keep accruing but nothing leaves this machine.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

BACKUP_AUTH_EXPIRED = RiskPattern(
    code="BACKUP_AUTH_EXPIRED",
    severity=RiskSeverity.WARNING.value,
    explanation="The backup push is failing for an AUTH reason (expired PAT, revoked ssh key, wrong gh account) — re-run `hub backup auth`. No amount of waiting fixes this one.",  # noqa: E501
    predicate=lambda perms, capabilities=None: [],
)

#: Consecutive push failures before `BACKUP_STALE` fires. Mirrors
#: `backup.PUSH_FAILURE_ALERT_THRESHOLD`; duplicated (not imported) so this
#: module keeps its no-dependency posture and the app mirror can read one table.
BACKUP_PUSH_FAILURE_THRESHOLD = 3

#: Days a restore may sit un-acknowledged before it counts as stale. A restore
#: HOLDS every push (`backup.pending_reconcile`), so an un-acknowledged one is
#: an indefinite backup outage wearing a "pending" label.
BACKUP_PENDING_RECONCILE_DAYS = 7

#: Substrings that make a push failure an AUTH failure rather than a network
#: one. Matched case-insensitively against `backup.last_push_error`.
_AUTH_ERROR_MARKERS: tuple[str, ...] = (
    "authentication failed",
    "could not read username",
    "could not read password",
    "permission denied",
    "invalid username or password",
    "bad credentials",
    "401",
    "403",
    "access denied",
    "not authorized",
    "unauthorized",
    "token expired",
    "expired token",
    "no usable github credential",
    "could not read the stored pat",
    "publickey",
)


def _is_auth_error(message: str) -> bool:
    lowered = str(message or "").lower()
    return any(marker in lowered for marker in _AUTH_ERROR_MARKERS)


def _pending_reconcile_age_days(stamp: Optional[str]) -> Optional[float]:
    """Days since an ISO-8601 `pending_reconcile_at`, or None if unreadable."""
    if not stamp:
        return None
    import datetime as _dt

    raw = str(stamp).strip().replace("Z", "+00:00")
    try:
        when = _dt.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=_dt.timezone.utc)
    delta = _dt.datetime.now(tz=_dt.timezone.utc) - when
    return delta.total_seconds() / 86400.0


def detect_backup_risks(backup_block: Optional[dict]) -> list[RiskFinding]:
    """Doctor findings for the registry `backup:` block.

    Reads the block RAW (not `backup.load_backup_config`) so `risks.py` keeps
    importing nothing from the backup module. No block at all → no findings:
    a user who never ran `hub backup init` is not running a broken backup.
    """
    if not isinstance(backup_block, dict) or not backup_block:
        return []
    findings: list[RiskFinding] = []

    try:
        failures = int(backup_block.get("push_failures") or 0)
    except (TypeError, ValueError):
        failures = 0
    last_error = str(backup_block.get("last_push_error") or "")

    if failures >= BACKUP_PUSH_FAILURE_THRESHOLD:
        findings.append(
            RiskFinding(
                code=BACKUP_STALE.code,
                severity=BACKUP_STALE.severity,
                explanation=BACKUP_STALE.explanation,
                detail=(
                    f"{failures} consecutive push failures — the cloud copy is stale "
                    f"({last_error or 'unknown error'})"
                ),
            )
        )

    if failures > 0 and _is_auth_error(last_error):
        findings.append(
            RiskFinding(
                code=BACKUP_AUTH_EXPIRED.code,
                severity=BACKUP_AUTH_EXPIRED.severity,
                explanation=BACKUP_AUTH_EXPIRED.explanation,
                detail=f"the last push failed on credentials: {last_error}",
            )
        )

    if backup_block.get("pending_reconcile"):
        age = _pending_reconcile_age_days(backup_block.get("pending_reconcile_at"))
        if age is None or age >= BACKUP_PENDING_RECONCILE_DAYS:
            age_text = (
                f"for {int(age)} day(s)" if age is not None else "since an earlier restore"
            )
            findings.append(
                RiskFinding(
                    code=BACKUP_STALE.code,
                    severity=BACKUP_STALE.severity,
                    explanation=BACKUP_STALE.explanation,
                    detail=(
                        f"a restore has been awaiting acknowledgement {age_text} and is "
                        f"holding every push — run `hub backup now --acknowledge-restore` "
                        f"once the restored state looks right"
                    ),
                )
            )

    rank = {"danger": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: (rank.get(f.severity, 99), f.code, f.detail))
    return findings


# Per-language checker binaries for the built-in lsp-report hook. Kept here (not
# imported from the lsp-report script) so this detector stays self-contained.
_LSP_CHECKERS: dict[str, str] = {
    "python": "ruff",
    "typescript": "tsc",
    "rust": "cargo",
    "go": "gopls",
}

# Executable-looking extensions used by the broken-script heuristic. A referenced
# script must carry one of these AND look path-ish (absolute / `~` / contains a
# separator) to be considered — this deliberately EXCLUDES bare interpreters
# (`python3`) and generated `--config …json` arguments (the missing-interpreter
# and generated-config cases are owned by the lsp-report wave, not this check).
_SCRIPT_EXTS: tuple[str, ...] = (
    ".py",
    ".sh",
    ".bash",
    ".zsh",
    ".rb",
    ".pl",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
)

# Verdicts for which a hook actually reaches a harness (so its risks are worth
# surfacing). NOT_INSTALLED / UNSUPPORTED harnesses receive no write, so emitting
# a per-hook finding for them would be noise.
_HOOK_REACHED_VERDICTS = frozenset({"supported", "feature_off"})


def candidate_script_paths(command: str) -> list[str]:
    """Extract script-path tokens from a hook command (broken-script heuristic,
    and the `hook show` "which script does this command run" detection).

    A token qualifies when it carries a script extension AND looks path-ish
    (absolute, `~`-prefixed, or containing a separator). Flags and env-assignment
    tokens (``FOO=/x``) are skipped. Interpreters and non-script args never match.
    """
    try:
        tokens = shlex.split(command or "")
    except ValueError:
        tokens = (command or "").split()
    out: list[str] = []
    for tok in tokens:
        if not tok or tok.startswith("-"):
            continue
        # Skip `VAR=value` env assignments (the `=` precedes any path separator).
        if "=" in tok.split("/", 1)[0]:
            continue
        lower = tok.lower()
        if not any(lower.endswith(ext) for ext in _SCRIPT_EXTS):
            continue
        if "/" not in tok and not tok.startswith("~"):
            continue
        out.append(tok)
    return out


# Thin alias — kept for any caller (and prior test) still spelling the old
# private name.
_candidate_script_paths = candidate_script_paths


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


def detect_hook_risks(
    resolved_hooks: "list[ResolvedHook]",
    capability: "HookCapability",
    harness_id: str = "",
) -> list[RiskFinding]:
    """Doctor findings for the hook library, evaluated per (scope, harness).

    Called by the shared doctor rollup for each harness a scope's hooks resolve
    to. Emits, for hooks that actually reach this harness (verdict supported /
    feature_off):

      * ``HOOK_RUNS_SUDO``     — command invokes sudo (same code/severity as the
                                 permission-block sudo scan in ``detect_risks``).
      * ``HOOK_BROKEN_SCRIPT`` — command references a script path absent on disk.
      * ``LSP_CHECKER_MISSING``— an lsp-report language is enabled but its checker
                                 binary is not on PATH (info).

    It NEVER emits the retired ``DROPPED_HOOK`` finding — codex is hook-capable
    (hooks-surface D3). A ``NOT_INSTALLED``/``UNSUPPORTED`` harness receives no
    hook write, so no findings are produced for it.
    """
    findings: list[RiskFinding] = []
    verdict = getattr(capability, "verdict", None)
    # `None` capability (defensive) is treated as "reached" so definition-level
    # issues still surface; only a KNOWN unreached verdict suppresses findings.
    if verdict is not None and verdict not in _HOOK_REACHED_VERDICTS:
        return findings

    for hook in resolved_hooks or []:
        name = getattr(hook, "name", "")
        command = getattr(hook, "command", "") or ""
        event = getattr(hook, "event", "") or ""

        # Sudo scan — mirrors _pred_hook_runs_sudo, over the library command.
        if _SUDO_RE.search(command):
            findings.append(
                RiskFinding(
                    code="HOOK_RUNS_SUDO",
                    severity=RiskSeverity.DANGER.value,
                    explanation=_HOOK_SUDO_EXPLANATION,
                    detail=f"{name} ({event}): {command}",
                )
            )

        # Broken-script — a referenced script path that does not exist on disk.
        # Script-backed hooks are exempt: their path is owned by
        # HOOK_SCRIPT_MISSING, which resolves a repo path against each attached
        # PROJECT root. This heuristic resolves relative tokens against hub's own
        # cwd, so a perfectly good `scripts/lint.sh` would look missing every time.
        script_backed = getattr(hook, "script", None) is not None
        for token in ([] if script_backed else _candidate_script_paths(command)):
            expanded = os.path.expanduser(token)
            if not Path(expanded).exists():
                findings.append(
                    RiskFinding(
                        code=HOOK_BROKEN_SCRIPT.code,
                        severity=HOOK_BROKEN_SCRIPT.severity,
                        explanation=HOOK_BROKEN_SCRIPT.explanation,
                        detail=f"{name}: missing script {token}",
                    )
                )

        # LSP checker + baked-interpreter presence — built-in lsp-report only.
        if _is_lsp_report(hook):
            findings.extend(_lsp_checker_findings(hook, harness_id))
            findings.extend(_lsp_interpreter_findings(hook, harness_id))

    rank = {"danger": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: (rank.get(f.severity, 99), f.code, f.detail))
    return findings


def detect_hook_script_risks(
    registry: Optional[dict], *, data_home: Optional[Path] = None
) -> list[RiskFinding]:
    """``HOOK_SCRIPT_MISSING`` over the hook library — one finding per hook.

    Registry-level (not per scope/harness) because a script's existence has
    nothing to do with which harness runs it: a *managed* body is one file in the
    data home, a *repo* script must exist in every project the hook is attached to
    (global attach ⇒ every registered project), and the projects that are missing
    it are listed in the single finding. Never raises — a weird registry yields no
    findings rather than breaking the doctor rollup.
    """
    if not isinstance(registry, dict):
        return []
    from skill_hub.domain.hooks import hooks_model
    from skill_hub.infrastructure.hooks import hook_scripts

    definitions = hooks_model.parse_registry_hooks(registry, warn=lambda _m: None)
    projects = registry.get("projects") or {}
    global_attached = [str(n) for n in (registry.get("hooks_global") or [])]

    findings: list[RiskFinding] = []
    for name in sorted(definitions):
        script = definitions[name].script
        if script is None:
            continue
        if script.source == "managed":
            try:
                path = hook_scripts.managed_script_path(name, script, data_home)
            except ValueError:
                # A non-slug name cannot address a managed dir at all — that IS
                # a missing script, and one bad entry must not abort the scan.
                findings.append(
                    RiskFinding(
                        code=HOOK_SCRIPT_MISSING.code,
                        severity=HOOK_SCRIPT_MISSING.severity,
                        explanation=HOOK_SCRIPT_MISSING.explanation,
                        detail=f"{name}: name cannot address a managed script dir",
                    )
                )
                continue
            if not path.exists():
                findings.append(
                    RiskFinding(
                        code=HOOK_SCRIPT_MISSING.code,
                        severity=HOOK_SCRIPT_MISSING.severity,
                        explanation=HOOK_SCRIPT_MISSING.explanation,
                        detail=f"{name}: managed script missing at {path}",
                    )
                )
            continue
        attached = [
            p_name
            for p_name, p_cfg in sorted(projects.items())
            if name in global_attached
            or name in ((p_cfg or {}).get("hooks") or [])
        ]
        missing = []
        for p_name in attached:
            root = ((projects.get(p_name) or {}).get("path")) or ""
            if not root:
                continue
            if not (Path(os.path.expanduser(str(root))) / script.path).exists():
                missing.append(p_name)
        if missing:
            findings.append(
                RiskFinding(
                    code=HOOK_SCRIPT_MISSING.code,
                    severity=HOOK_SCRIPT_MISSING.severity,
                    explanation=HOOK_SCRIPT_MISSING.explanation,
                    detail=(
                        f"{name}: repo script '{script.path}' missing in "
                        f"{', '.join(missing)}"
                    ),
                )
            )
    return findings


def _is_lsp_report(hook: "ResolvedHook") -> bool:
    """Identify the built-in lsp-report hook defensively by name/provenance."""
    name = getattr(hook, "name", "") or ""
    provenance = getattr(hook, "provenance", "") or ""
    return name == "lsp-report" or (provenance == "builtin" and name == "lsp-report")


def _lsp_checker_findings(
    hook: "ResolvedHook", harness_id: str
) -> list[RiskFinding]:
    """One LSP_CHECKER_MISSING per enabled language whose checker binary is absent.

    Reads the merged per-language settings shape
    ``settings.languages.<lang> = {enabled, mode, timeout}`` (builtin-lsp-hook
    spec) with its own lightweight lookup and its own ``shutil.which`` probe — no
    dependency on the lsp-report script's internals.
    """
    settings = getattr(hook, "settings", None) or {}
    langs = settings.get("languages") if isinstance(settings, dict) else None
    if not isinstance(langs, dict):
        return []
    out: list[RiskFinding] = []
    scope = f" [{harness_id}]" if harness_id else ""
    for lang, cfg in langs.items():
        if not isinstance(cfg, dict) or cfg.get("enabled") is not True:
            continue
        binary = _LSP_CHECKERS.get(str(lang))
        if binary is None:
            continue
        if shutil.which(binary) is None:
            out.append(
                RiskFinding(
                    code=LSP_CHECKER_MISSING.code,
                    severity=LSP_CHECKER_MISSING.severity,
                    explanation=LSP_CHECKER_MISSING.explanation,
                    detail=(
                        f"lsp-report{scope}: {lang} checker '{binary}' not found "
                        f"on PATH"
                    ),
                )
            )
    return out


def _lsp_interpreter_findings(
    hook: "ResolvedHook", harness_id: str
) -> list[RiskFinding]:
    """Flag a baked lsp-report interpreter path that no longer exists on disk
    (builtin-lsp-hook spec, "Missing baked interpreter is flagged by doctor").

    The command's first shlex token is the interpreter `lsp_report_sync.py`
    baked in at write time (shell-quoted since the review-panel fix — parse
    with `shlex.split`, not a plain space-split, or a quoted path with a space
    would be mis-sliced).
    """
    command = getattr(hook, "command", "") or ""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return []
    if not tokens:
        return []
    interpreter = tokens[0]
    if not interpreter:
        return []
    if Path(interpreter).exists():
        return []
    scope = f" [{harness_id}]" if harness_id else ""
    return [
        RiskFinding(
            code=LSP_INTERPRETER_MISSING.code,
            severity=LSP_INTERPRETER_MISSING.severity,
            explanation=LSP_INTERPRETER_MISSING.explanation,
            detail=f"lsp-report{scope}: baked interpreter not found: {interpreter}",
        )
    ]


def detect_companion_risks(registry: Optional[dict]) -> list[RiskFinding]:
    """Doctor findings for the `ships_with` companion ownership ledger (W3).

    Registry-level, like `detect_hook_script_risks` and `detect_backup_risks` —
    a companion's standing has nothing to do with which harness runs it, and
    the ledger (`projects.<n>.companions`) already spans every project. Reads
    `ships_with.orphans`/`ships_with.pending` (function-scoped import, so this
    module keeps its no-dependency posture on the common path):

      * ``COMPANION_ORPHANED`` (warning) — one per `orphans()` entry: either
        the ledgered skill fell out of the project's active set (a
        `--keep-companions` disable, or a companion reached only through a
        bundle — bundles never provision), or a specific ledger item (a hook
        or agent name) is no longer named in the skill's CURRENT `ships_with`
        declaration (an upstream edit or source update dropped it).
      * ``COMPANIONS_PENDING`` (info) — one per `pending()` entry: an active
        `ships_with` skill with no ledger entry at all — reached via a bundle,
        or equipped skill-only alongside a `--with-refs` referrer — so its
        companions were never offered for consent.
      * ``COMPANION_REF_MISSING`` (warning) — one per `ships_with_reconcile
        .classify()["missing_refs"]` entry: a declared `{ref: <name>}` hook
        names a hooks-library definition that no longer exists.
      * ``COMPANION_AGENT_DRIFT`` (warning) — one per `classify()
        ["agent_drift"]` entry: a companion agent's rendered file on disk no
        longer matches the hash the ledger recorded (hand-edited outside the
        skill); reconcile never clobbers it, so the doctor is how it surfaces.

    Read-only: never mutates the registry. Never raises — a weird registry
    yields no findings rather than breaking the doctor rollup. The
    `classify()` call is its own error boundary: an exception there (a
    malformed ledger/declaration shape `plan_reconcile` does not tolerate)
    prints one warning line and drops only the two `classify`-fed codes —
    `COMPANION_ORPHANED`/`COMPANIONS_PENDING` findings already collected from
    `orphans()`/`pending()` above are still returned.
    """
    if not isinstance(registry, dict):
        return []
    from skill_hub.application.skills import ships_with_reconcile
    from skill_hub.domain.skills import ships_with

    findings: list[RiskFinding] = []

    for item in ships_with.orphans(registry):
        project = item.get("project")
        skill = item.get("skill")
        if item.get("reason") == "declaration_dropped":
            kind = item.get("kind")
            name = item.get("name")
            detail = (
                f"{project}: {skill}'s ships_with no longer declares the {kind} "
                f"'{name}', but the ledger still lists it"
            )
        else:
            detail = (
                f"{project}: {skill} is no longer active on this project but its "
                f"companions are still provisioned (--keep-companions, or reached "
                f"only via a bundle)"
            )
        findings.append(
            RiskFinding(
                code=COMPANION_ORPHANED.code,
                severity=COMPANION_ORPHANED.severity,
                explanation=COMPANION_ORPHANED.explanation,
                detail=detail,
            )
        )

    for item in ships_with.pending(registry):
        project = item.get("project")
        skill = item.get("skill")
        findings.append(
            RiskFinding(
                code=COMPANIONS_PENDING.code,
                severity=COMPANIONS_PENDING.severity,
                explanation=COMPANIONS_PENDING.explanation,
                detail=f"{project}: {skill} is active with no companion ledger entry",
            )
        )

    try:
        classified = ships_with_reconcile.classify(registry)
    except Exception as exc:  # never let this leg's dependency crash the doctor rollup
        print(f"  ships_with companion classify skipped: {exc}")
        classified = {}

    for item in classified.get("missing_refs") or []:
        scope = item.get("scope")
        skill = item.get("skill")
        name = item.get("name")
        ref = item.get("ref")
        findings.append(
            RiskFinding(
                code=COMPANION_REF_MISSING.code,
                severity=COMPANION_REF_MISSING.severity,
                explanation=COMPANION_REF_MISSING.explanation,
                detail=(
                    f"{scope}: {skill}'s companion hook '{name}' references "
                    f"'{ref}', which is no longer in the hooks library"
                ),
            )
        )

    for item in classified.get("agent_drift") or []:
        scope = item.get("scope")
        skill = item.get("skill")
        agent = item.get("agent")
        harnesses = ", ".join(item.get("harnesses") or [])
        findings.append(
            RiskFinding(
                code=COMPANION_AGENT_DRIFT.code,
                severity=COMPANION_AGENT_DRIFT.severity,
                explanation=COMPANION_AGENT_DRIFT.explanation,
                detail=(
                    f"{scope}: {skill}'s companion agent '{agent}' was hand-edited "
                    f"outside the skill on {harnesses}"
                ),
            )
        )

    rank = {"danger": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: (rank.get(f.severity, 99), f.code, f.detail))
    return findings


def emit_schema() -> list[dict]:
    """Serialize the risk codes for the Rust/TS mirror. Predicates are dropped.

    Includes the `detect_risks`-evaluated `RISK_PATTERNS`, the adapter-raised
    `DROPPED_DENY`, and the hook-library codes (`HOOK_BROKEN_SCRIPT`,
    `LSP_CHECKER_MISSING`, `LSP_INTERPRETER_MISSING`) so the UI mirror has a
    label/severity for every code the engine can emit. (`HOOK_RUNS_SUDO` is
    already in `RISK_PATTERNS`.)
    """
    all_patterns = list(RISK_PATTERNS) + [
        DROPPED_DENY,
        HOOK_BROKEN_SCRIPT,
        HOOK_SCRIPT_MISSING,
        LSP_CHECKER_MISSING,
        LSP_INTERPRETER_MISSING,
        BACKUP_STALE,
        BACKUP_AUTH_EXPIRED,
        COMPANION_ORPHANED,
        COMPANIONS_PENDING,
        COMPANION_REF_MISSING,
        COMPANION_AGENT_DRIFT,
    ]
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
