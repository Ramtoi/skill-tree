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

Backup codes (raised by `detect_backup_risks` over the registry `backup:` block —
they need registry context, so they are NOT run by `detect_risks`):
    BACKUP_STALE            - repeated push failures, or a restore still holding
                              every push while awaiting acknowledgement
    BACKUP_AUTH_EXPIRED     - the last push failed for an auth reason

Retired: `DROPPED_HOOK` ("Codex has no hooks") — codex IS hook-capable and hooks
are no longer authored from the permissions block (hooks-surface D3/D6).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from harness_probe import HookCapability
    from hooks_model import ResolvedHook


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
        explanation="An allow and a deny share the same pattern. Deny wins at runtime, so the allow is dead — remove one.",
        predicate=_pred_contradictory_rule,
    ),
]


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
    explanation="A deny/ask security control was dropped because this harness cannot express it — the control silently does not apply here.",
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
    explanation="A language is enabled for the lsp-report hook but its checker binary is not on PATH — that language is a silent runtime no-op.",
    predicate=lambda perms, capabilities=None: [],
)

LSP_INTERPRETER_MISSING = RiskPattern(
    code="LSP_INTERPRETER_MISSING",
    severity=RiskSeverity.WARNING.value,
    explanation="The lsp-report hook's baked interpreter path no longer exists on disk — the hook will fail to run at all until the next sync re-bakes it.",
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
    explanation="The cloud copy of the backup is not current — pushes have been failing, or a restore is still awaiting acknowledgement. Local snapshots keep accruing but nothing leaves this machine.",
    predicate=lambda perms, capabilities=None: [],
)

BACKUP_AUTH_EXPIRED = RiskPattern(
    code="BACKUP_AUTH_EXPIRED",
    severity=RiskSeverity.WARNING.value,
    explanation="The backup push is failing for an AUTH reason (expired PAT, revoked ssh key, wrong gh account) — re-run `hub backup auth`. No amount of waiting fixes this one.",
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


def _candidate_script_paths(command: str) -> list[str]:
    """Extract script-path tokens from a hook command (broken-script heuristic).

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
        for token in _candidate_script_paths(command):
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
        LSP_CHECKER_MISSING,
        LSP_INTERPRETER_MISSING,
        BACKUP_STALE,
        BACKUP_AUTH_EXPIRED,
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
