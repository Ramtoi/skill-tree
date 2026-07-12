"""Gap & unhappy-edge-case reproductions for the permissions feature (TDD red).

These tests come out of the permissions coverage audit
(`permissions-coverage-analysis.html`). Each one encodes the *desired* behavior
for a gap or an unsafe edge case the current engine does not handle. They are
marked `xfail(strict=True)` so that:

  * today they document the gap (pytest reports them as XFAIL — a reproduction);
  * the assertion body is the executable spec for the eventual fix;
  * when a fix lands, the test XPASSes and `strict=True` turns that into a hard
    failure, forcing whoever fixed it to delete the marker (the TDD ratchet).

Where it clarifies the reproduction, a gap is paired with a *passing*
characterization test that pins the current (unsafe / missing) behavior using
only assertions that will remain true after a fix (e.g. "the deny IS skipped"),
so the pair stays low-maintenance.

Grouping mirrors the audit:
  A. Scope & hierarchy           (personal-per-project, monorepo, enforced tier)
  B. Skill / bundle integration  (permissions decoupled from skills)
  C. Silently dropped security controls (deny / hook / path-deny on Bash-only harnesses)
  D. Rule semantics & lint       (contradiction, dead rules, syntactic validation)
  E. No rule simulator
"""

from __future__ import annotations

import pytest

import permission_adapters as pa
import permission_presets as pp
from permissions import (
    GlobalScope,
    Hook,
    NormalizedPermissions,
    ProjectScope,
    Rule,
    resolve_effective,
)
from risks import detect_risks


# Convenience: a strict-xfail marker with a uniform reason prefix.
def gap(reason: str):
    return pytest.mark.xfail(strict=True, reason=f"GAP: {reason}")


def _reg(*, global_block=None, project_block=None, project_path="/tmp/p"):
    project = {"path": project_path, "permissions": project_block or {}}
    registry = {
        "permissions_global": global_block or {},
        "projects": {"alpha": project},
    }
    return project, registry


# ─────────────────────────────────────────────────────────────────────────────
# A. Scope & hierarchy
# ─────────────────────────────────────────────────────────────────────────────


def test_gap_no_personal_per_project_local_settings_tier():
    """A developer wants per-project rules that are NOT committed for teammates.

    Desired: the Claude path config exposes a project-local tier that the adapter
    can target, mapping to `.claude/settings.local.json` (the harness's native
    gitignored personal layer).
    """
    paths = pa._CLAUDE_PATHS["claude-code"]
    assert "project_local" in paths
    assert str(paths["project_local"]).endswith(".claude/settings.local.json")


@gap("a project is one root with one native settings file; rules cannot be "
     "scoped to a subdirectory of a monorepo.")
def test_gap_no_subproject_directory_scope(tmp_path):
    """Monorepo: `frontend/` may run npm, `backend/` may not.

    Desired: an adapter can target a nested settings file for a sub-path of the
    project, e.g. `target_files(scope, harness, subpath="frontend")` →
    `<repo>/frontend/.claude/settings.json`.
    """
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name="mono", path=str(tmp_path))
    nested = adapter.target_files(scope, "claude-code", subpath="frontend")
    assert str(nested).endswith("frontend/.claude/settings.json")


@gap("only two tiers exist (user-global, project) and project ALWAYS wins; there "
     "is no enforced/managed policy tier an org admin can make non-overridable.")
def test_gap_enforced_global_rule_cannot_be_overridden_by_project():
    """Security team mandates `deny Bash(curl:*)` org-wide; a project must not be
    able to neutralise it with an allow.

    Desired: a global rule flagged enforced is NOT shadowed/contradicted by a
    project rule. The resolver should drop or flag the contradicting project rule
    when an enforced global policy exists.

    Today: the project allow survives unflagged (different `kind` from the global
    deny), and at runtime ordering/precedence is harness-dependent — there is no
    enforcement concept at all.
    """
    project, registry = _reg(
        global_block={
            # `enforced` is the proposed flag — does not exist yet.
            "deny": [{"pattern": "Bash(curl:*)", "kind": "deny", "enforced": True}],
        },
        project_block={
            "allow": [{"pattern": "Bash(curl:*)", "kind": "allow"}],
        },
    )
    eff = resolve_effective(project, registry)
    # The contradicting project allow must not be active against an enforced deny.
    active_project_allows = [
        r for r in eff.allow if r.pattern == "Bash(curl:*)" and r.origin == "project"
    ]
    assert active_project_allows == []


# ─────────────────────────────────────────────────────────────────────────────
# B. Skill / bundle integration  (the conceptual gap unique to a *skill* hub)
# ─────────────────────────────────────────────────────────────────────────────


@gap("a SKILL.md cannot declare the permissions it requires; nothing reads a "
     "`permissions:` frontmatter block.")
def test_gap_skill_md_cannot_declare_required_permissions(tmp_path):
    """A `deploy` skill needs `Bash(kubectl:*)` to function.

    Desired: a helper extracts a skill's declared permission requirements from
    SKILL.md so sync can stamp / warn about them.
    """
    skill = tmp_path / "deploy"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\n"
        "name: deploy\n"
        "description: ship it\n"
        "permissions:\n"
        "  allow:\n"
        "    - Bash(kubectl:*)\n"
        "---\n"
    )
    # Proposed API — does not exist yet.
    required = pp.skill_required_permissions(skill / "SKILL.md")
    assert any(r["pattern"] == "Bash(kubectl:*)" for r in required["allow"])


@gap("applying a bundle never stamps permissions; presets are the only rule "
     "bundle primitive and they must be applied manually & separately.")
def test_gap_bundle_does_not_carry_permissions():
    """A bundle should be able to reference a preset so equipping it also grants
    the permissions its skills need.

    Desired: a bundle definition may carry `permission_preset: <id>` and a helper
    resolves the rules a bundle contributes.
    """
    registry = {
        "bundles": {
            "android": {
                "description": "android stack",
                "skills": ["build"],
                "permission_preset": "android-gradle",
            }
        },
    }
    # Proposed API — does not exist yet.
    rules = pp.bundle_contributed_rules("android", registry)
    assert any(r["pattern"].startswith("Bash(./gradlew") for r in rules)


# ─────────────────────────────────────────────────────────────────────────────
# C. Silently dropped security controls on Bash-only harnesses
#    (the highest-value reproductions: a DENY / security hook is a control, and
#     dropping a control should be louder than dropping a convenience allow.)
# ─────────────────────────────────────────────────────────────────────────────


def test_current_path_deny_IS_dropped_on_codex_as_plain_skip():
    """Characterization: a `deny Read(secrets/**)` security rule is skipped on
    Codex (Bash-only) as a SkipReason. The skip ASSERTION below stays true after
    the fix (the rule still cannot be expressed). The fix landed: dropping the
    deny now ALSO raises a DROPPED_DENY risk (see the escalation test), so the
    risk assertion is updated to expect that escalation rather than its absence.
    """
    perms = NormalizedPermissions(deny=[Rule(pattern="Read(secrets/**)", kind="deny")])
    result = pa.CodexPermissionAdapter().translate(perms, GlobalScope(), "codex")
    assert any(s.rule_pattern == "Read(secrets/**)" for s in result.skipped)
    # Fix landed: dropping a security control is now escalated to a risk.
    assert any("deny" in (f.code or "").lower() for f in result.risks)


def test_gap_dropped_deny_on_codex_should_escalate_to_risk():
    """Desired: skipping a `deny` (or `ask`) rule on a harness that can't express
    it raises a risk finding (e.g. DROPPED_DENY), because a dropped control is a
    security regression, unlike a dropped convenience allow.
    """
    perms = NormalizedPermissions(deny=[Rule(pattern="Read(secrets/**)", kind="deny")])
    result = pa.CodexPermissionAdapter().translate(perms, GlobalScope(), "codex")
    codes = {f.code for f in result.risks}
    assert "DROPPED_DENY" in codes


def test_gap_dropped_security_hook_on_codex_should_escalate():
    """A compliance team relies on a PreToolUse audit hook everywhere. On Codex it
    is dropped. Desired: that drop is surfaced as a risk, not just a SkipReason.
    """
    perms = NormalizedPermissions(
        hooks=[Hook(event="PreToolUse", matcher="Bash", command="/usr/local/bin/audit")]
    )
    result = pa.CodexPermissionAdapter().translate(perms, GlobalScope(), "codex")
    # The hook IS skipped today (characterized inline) ...
    assert any(s.feature == "hooks" for s in result.skipped)
    # ... but desired: an escalated risk so the gap in coverage is loud.
    assert any(f.code == "DROPPED_HOOK" for f in result.risks)


def test_gap_dropped_path_deny_on_opencode_should_escalate():
    perms = NormalizedPermissions(deny=[Rule(pattern="Write(/etc/**)", kind="deny")])
    adapter = pa.OpenCodePermissionAdapter()
    result = adapter.translate(perms, GlobalScope(), "opencode")
    assert any(s.rule_pattern == "Write(/etc/**)" for s in result.skipped)  # dropped today
    assert any(f.code == "DROPPED_DENY" for f in result.risks)              # desired


# ─────────────────────────────────────────────────────────────────────────────
# D. Rule semantics & lint
# ─────────────────────────────────────────────────────────────────────────────


def test_current_contradictory_allow_deny_is_flagged():
    """Characterization: an `allow` and a `deny` of the *same* pattern coexist;
    the harness silently resolves deny-over-allow so the allow is dead. The fix
    landed — `detect_risks` now flags this with CONTRADICTORY_RULE (updated from
    the pre-fix assertion that the code was ABSENT).
    """
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(rm:*)", kind="allow")],
        deny=[Rule(pattern="Bash(rm:*)", kind="deny")],
    )
    codes = {f.code for f in detect_risks(perms)}
    assert "CONTRADICTORY_RULE" in codes  # fix landed: the dead allow is caught


def test_gap_contradictory_allow_deny_should_be_flagged():
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(rm:*)", kind="allow")],
        deny=[Rule(pattern="Bash(rm:*)", kind="deny")],
    )
    codes = {f.code for f in detect_risks(perms)}
    assert "CONTRADICTORY_RULE" in codes


def test_gap_project_allow_shadowed_by_global_deny_should_be_flagged():
    """Desired: resolve_effective marks a project allow that is overridden by a
    higher-precedence global deny so the UI can grey it out / warn, instead of
    showing an allow the developer believes is active.
    """
    project, registry = _reg(
        global_block={"deny": [{"pattern": "Bash(curl:*)", "kind": "deny"}]},
        project_block={"allow": [{"pattern": "Bash(curl:*)", "kind": "allow"}]},
    )
    eff = resolve_effective(project, registry)
    project_allow = next(
        r for r in eff.allow if r.pattern == "Bash(curl:*)" and r.origin == "project"
    )
    # Proposed provenance flag — does not exist yet.
    assert getattr(project_allow, "shadowed_by_deny", False) is True


def test_gap_malformed_pattern_should_fail_validation():
    """`Bash(npm:*` (missing closing paren) is a typo that silently does nothing
    at runtime. Desired: validate() rejects syntactically malformed patterns.
    """
    adapter = pa.ClaudePermissionAdapter()
    res = adapter.validate(Rule(pattern="Bash(npm:*", kind="allow"))
    assert not res.ok


# ─────────────────────────────────────────────────────────────────────────────
# E. No rule simulator / "would command X be allowed?"
# ─────────────────────────────────────────────────────────────────────────────


def test_gap_no_rule_decision_simulator():
    """Desired: a pure evaluator resolves a concrete command against a rule set so
    a developer can confirm a deny-exception behaves as intended before syncing.
    """
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(git:*)", kind="allow")],
        deny=[Rule(pattern="Bash(git push:*)", kind="deny")],
    )
    # Proposed API — does not exist yet.
    assert pa.evaluate_decision(perms, "git status") == "allow"
    assert pa.evaluate_decision(perms, "git push origin main") == "deny"
