"""OpenCode permission adapter: `opencode.json` `permission.bash` last-match-wins
prefixes. Split out of `permission_adapters.py` (wave 22b of AUDIT.md) — see
that module's docstring for the adapter contract.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from skill_hub.domain.harnesses.harness_adapter_api import PermissionCommandRule
from skill_hub.domain.permissions.permission_adapter_base import (
    NativeWrite,
    SkipReason,
    TranslateResult,
    ValidationResult,
    _atomic_replace,
    _backup_once_per_session,
    _bash_prefix_tokens,
    _detect_risks_for_translate,
    _kind_feature,
)
from skill_hub.domain.permissions.permissions import (
    GlobalScope,
    NormalizedPermissions,
    PermissionFeature,
    Rule,
    Scope,
    delete_sidecar,
    read_sidecar,
    write_sidecar,
)
from skill_hub.infrastructure.harnesses.harness_bundled_permissions import OpenCodePermissionCodec

# ─────────────────────────────────────────────────────────────────────────────
# opencode adapter — opencode.json `permission.bash` (last-match-wins prefixes)
# ─────────────────────────────────────────────────────────────────────────────


_OPENCODE_CAPS = {
    PermissionFeature.TOOL_ALLOWLIST,
    PermissionFeature.TOOL_DENYLIST,
    PermissionFeature.TOOL_ASK,
}

# opencode permission action == hub kind, 1:1 (cleaner than Codex's `prompt`).
# Verified against https://opencode.ai/config.json (fetched 2026-06-10).
_OPENCODE_DECISION = {"allow": "allow", "ask": "ask", "deny": "deny"}

_OPENCODE_BASH_PREFIX = "permission.bash."  # managed-key namespace in the sidecar
_PERMISSION_CODEC = OpenCodePermissionCodec()


def _opencode_target(scope: Scope) -> Path:
    """`~/.config/opencode/opencode.json` (global) or `<repo>/opencode.json`."""
    if isinstance(scope, GlobalScope):
        return Path("~/.config/opencode/opencode.json").expanduser()
    return Path(scope.path) / "opencode.json"


def _opencode_bash_prefix(tokens: list[str]) -> str:
    """Compatibility wrapper for the former host helper."""
    return _PERMISSION_CODEC.bash_prefix(tuple(tokens))


def _opencode_pattern_from_prefix(prefix: str) -> Optional[str]:
    """Compatibility wrapper for the former host helper."""
    return _PERMISSION_CODEC.pattern_from_prefix(prefix)


def _opencode_sort_key(tokens: list[str]) -> tuple:
    """Compatibility wrapper for the former host helper."""
    return _PERMISSION_CODEC.sort_key(tuple(tokens))


class OpenCodePermissionAdapter:
    """Writes opencode per-command bash permissions into `opencode.json`.

    opencode stores permissions under the top-level `permission` key in the
    SAME file the MCP adapter targets — global `~/.config/opencode/
    opencode.json`, project `<repo>/opencode.json`. Per-command bash rules live
    under `permission.bash` as an OBJECT mapping space-separated glob prefixes
    to actions (`"npm *": "allow"`), evaluated **last-match-wins**. Verified
    against https://opencode.ai/config.json (fetched 2026-06-10).

    Translation: each registry `Bash(<cmd…>:*)` rule → one `permission.bash`
    entry (`_bash_prefix_tokens` → `"<cmd…> *"`); kinds map 1:1
    (`allow`/`ask`/`deny`). Rules are emitted most-specific-last so a specific
    rule overrides a broader one under last-match-wins. Non-Bash tool rules,
    unbounded `Bash(*)`, and ALL hooks are skipped (opencode has no
    permission-hook target). The bash map is a dict, not an indexed list, so
    this adapter owns its own strip/splice (it cannot use the index-based
    `_strip_managed_from_json`). Managed keys are tracked as
    `permission.bash.<prefix>` in the per-file sidecar; writes are
    merge-preserving (user `permission.*` keys and the `mcp` block survive).
    """

    def __init__(self, layout=None):
        self._layout = layout

    def target_files(self, scope: Scope, harness_id: str) -> Path:
        if self._layout is not None:
            if isinstance(scope, GlobalScope):
                if self._layout.permission_global_config is not None:
                    return Path(self._layout.permission_global_config)
            elif self._layout.permission_project_config is not None:
                return Path(scope.path) / self._layout.permission_project_config
            raise ValueError("permission target is unavailable in this operation")
        return _opencode_target(scope)

    def capabilities(self) -> set:
        return set(_OPENCODE_CAPS)

    def validate(self, rule: Rule) -> ValidationResult:
        if not rule.pattern:
            return ValidationResult(ok=False, error="empty pattern")
        if rule.kind not in {"allow", "deny", "ask"}:
            return ValidationResult(ok=False, error=f"unknown kind {rule.kind!r}")
        return ValidationResult(ok=True)

    def translate(
        self,
        perms: NormalizedPermissions,
        scope: Scope,
        harness_id: str,
    ) -> TranslateResult:
        target = self.target_files(scope, harness_id)
        result = TranslateResult()
        caps = self.capabilities()

        def applicable(rule: Rule) -> bool:
            if rule.harnesses is not None and harness_id not in rule.harnesses:
                return False
            return _kind_feature(rule.kind) in caps

        # Collect (tokens, kind) for translatable Bash rules; skip the rest.
        entries: list[PermissionCommandRule] = []
        for kind, rules in (("allow", perms.allow), ("deny", perms.deny), ("ask", perms.ask)):
            for r in rules:
                if not applicable(r):
                    continue
                tokens = _bash_prefix_tokens(r.pattern)
                if tokens is None:
                    result.skipped.append(SkipReason(
                        feature=_kind_feature(kind).value,
                        reason=(
                            "opencode bash rules need a bounded command prefix; "
                            "non-Bash tools and unbounded Bash(*) are not translatable"
                        ),
                        rule_pattern=r.pattern,
                    ))
                    # Dropping a deny/ask security control is a regression — escalate.
                    if kind in ("deny", "ask"):
                        from skill_hub.domain.diagnostics import risks as _risks
                        result.risks.append(
                            _risks.dropped_deny_finding(r.pattern, harness_id, kind)
                        )
                    continue
                entries.append(PermissionCommandRule(tuple(tokens), kind, r.pattern))

        # Hooks are owned by the hook library + hooks sync stream (hooks-surface
        # D6); the permissions block no longer carries them, so the retired
        # DROPPED_HOOK skip/risk is no longer emitted here.

        # Typed Codex-only fields + additional dirs + extras are not representable.
        if perms.sandbox_mode is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.SANDBOX_MODE.value,
                reason="opencode has no sandbox_mode field",
            ))
        if perms.approval_policy is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.APPROVAL_POLICY.value,
                reason="opencode has no approval_policy field",
            ))
        if perms.project_trust is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.PROJECT_TRUST.value,
                reason="opencode has no project_trust field",
            ))
        for d in perms.additional_dirs:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.ADDITIONAL_DIRECTORIES.value,
                reason="opencode has no additional-directories permission field",
                detail=d,
            ))
        for extras_key in perms.extras.keys():
            result.skipped.append(SkipReason(
                feature=extras_key,
                reason=f"opencode adapter does not recognise extras key {extras_key!r}",
            ))

        # Order most-specific-LAST (last-match-wins). Insertion order into the
        # dict == JSON key order == opencode evaluation order. A later duplicate
        # prefix (same command, divergent kind) wins, matching opencode runtime.
        bash_rules = dict(_PERMISSION_CODEC.encode(tuple(entries)))

        managed_keys = [f"{_OPENCODE_BASH_PREFIX}{prefix}" for prefix in bash_rules]

        result.writes.append(NativeWrite(
            target_path=target,
            payload={"bash": bash_rules},
            managed_keys=managed_keys,
            format="json",
        ))
        # Keep any DROPPED_DENY escalations appended above.
        result.risks = _detect_risks_for_translate(perms, caps) + result.risks
        return result

    # ── apply / cleanup own their dict-keyed strip (not the list-index helper) ──

    def _strip_managed(self, data: dict, managed_keys: list[str]) -> None:
        perm = data.get("permission")
        if not isinstance(perm, dict):
            return
        bash = perm.get("bash")
        if not isinstance(bash, dict):
            return
        for key in managed_keys:
            if not key.startswith(_OPENCODE_BASH_PREFIX):
                continue
            prefix = key[len(_OPENCODE_BASH_PREFIX):]
            bash.pop(prefix, None)
        if not bash:
            perm.pop("bash", None)
        if not perm:
            data.pop("permission", None)

    def apply(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        target = write.target_path
        bash_rules: dict[str, str] = write.payload["bash"]

        prior = read_sidecar(harness_id, scope)
        # Nothing to write and nothing previously managed → never create a file.
        if not bash_rules and not target.exists() and (prior is None or not prior.managed_keys):
            return False

        _backup_once_per_session(target, scope, harness_id)

        existing: dict = {}
        if target.exists():
            try:
                with open(target) as f:
                    loaded = json.load(f)
                existing = loaded if isinstance(loaded, dict) else {}
            except (OSError, json.JSONDecodeError):
                existing = {}

        if prior is not None and prior.managed_keys:
            self._strip_managed(existing, prior.managed_keys)

        new_managed_keys: list[str] = []
        if bash_rules:
            perm_section = existing.get("permission")
            if not isinstance(perm_section, dict):
                perm_section = {}
            bash_section = perm_section.get("bash")
            # opencode allows `bash` to be a bare action string; promote it to
            # object form under "*" so we can splice without losing the user's
            # global default.
            if isinstance(bash_section, str):
                bash_section = {"*": bash_section}
            elif not isinstance(bash_section, dict):
                bash_section = {}
            for prefix, decision in bash_rules.items():
                bash_section[prefix] = decision
                new_managed_keys.append(f"{_OPENCODE_BASH_PREFIX}{prefix}")
            perm_section["bash"] = bash_section
            existing["permission"] = perm_section

        _atomic_replace(target, json.dumps(existing, indent=2, sort_keys=False) + "\n")
        write_sidecar(harness_id, scope, new_managed_keys, target)
        return True

    def cleanup(self, scope: Scope, harness_id: str) -> bool:
        sc = read_sidecar(harness_id, scope)
        if sc is None:
            return False
        target = Path(sc.file)
        if not target.exists():
            delete_sidecar(harness_id, scope)
            return True
        try:
            with open(target) as f:
                loaded = json.load(f)
            data = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            return False
        self._strip_managed(data, sc.managed_keys)
        _atomic_replace(target, json.dumps(data, indent=2) + "\n")
        delete_sidecar(harness_id, scope)
        return True

    def discover_existing(
        self,
        scope: Scope,
        harness_id: str,
        project_path: Optional[Path] = None,
    ) -> NormalizedPermissions:
        target = self.target_files(scope, harness_id)
        if not target.exists():
            return NormalizedPermissions()
        try:
            with open(target) as f:
                loaded = json.load(f)
            data = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            return NormalizedPermissions()
        perm = data.get("permission")
        bash = perm.get("bash") if isinstance(perm, dict) else None
        buckets: dict[str, list[Rule]] = {"allow": [], "deny": [], "ask": []}
        if isinstance(bash, dict):
            for observation in _PERMISSION_CODEC.decode(bash):
                if not observation.importable or observation.tokens is None:
                    continue
                kind = {"allow": "allow", "ask": "ask", "deny": "deny"}.get(
                    observation.native_decision or ""
                )
                if kind is None:
                    continue
                pattern = _opencode_pattern_from_prefix(observation.native_pattern or "")
                if pattern is None:
                    continue
                buckets[kind].append(Rule(pattern=pattern, kind=kind))
        return NormalizedPermissions(
            allow=buckets["allow"], deny=buckets["deny"], ask=buckets["ask"]
        )

    def discover_candidates(self, scope: Scope, harness_id: str) -> list[dict]:
        """opencode bash rules as cross-harness import candidates. Every
        translatable prefix round-trips through the registry's Bash model, so
        all discovered rules are importable; `drop` later removes the key from
        `opencode.json` directly (no source span needed)."""
        discovered = self.discover_existing(scope, harness_id)
        target = self.target_files(scope, harness_id)
        out: list[dict] = []
        for kind, rules in (
            ("allow", discovered.allow),
            ("deny", discovered.deny),
            ("ask", discovered.ask),
        ):
            for r in rules:
                out.append({
                    "pattern": r.pattern,
                    "kind": kind,
                    "decision": None,
                    "source": target.name,
                    "harness": harness_id,
                    "file": str(target),
                    "lineno": None,
                    "end_lineno": None,
                    "importable": True,
                    "reason": None,
                })
        return out
