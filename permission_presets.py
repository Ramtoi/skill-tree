"""Permission presets — named bundles of allow/deny/ask rules that can be
stamped into a project's permission block in one shot.

Two built-in presets are emitted from code (never written to the registry):
  - `git-safe`     — non-destructive read-only git inspection commands
  - `android-gradle` — common Gradle build, test, lint, KSP tasks

User-defined presets live in `registry.yaml` under a top-level
`permission_presets:` key. Application is rule stamping: selected rules are
merged into the project's allow list, deduped on `(pattern, kind)`. There is
no "applied preset" record — once applied the rules are first-class project
rules editable like any other.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Dataclasses
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class PresetRule:
    pattern: str
    kind: str = "allow"  # allow | deny | ask
    description: str = ""
    enabled_by_default: bool = True

    def to_dict(self) -> dict:
        return {
            "pattern": self.pattern,
            "kind": self.kind,
            "description": self.description,
            "enabled_by_default": self.enabled_by_default,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PresetRule":
        return cls(
            pattern=str(data["pattern"]),
            kind=str(data.get("kind", "allow")),
            description=str(data.get("description", "")),
            enabled_by_default=bool(data.get("enabled_by_default", True)),
        )


@dataclass
class PermissionPreset:
    id: str
    name: str
    description: str
    icon: str
    category: str  # "vcs" | "build" | "custom"
    builtin: bool = True
    rules: list[PresetRule] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "category": self.category,
            "builtin": self.builtin,
            "rules": [r.to_dict() for r in self.rules],
        }


# ─────────────────────────────────────────────────────────────────────────────
# Built-in preset definitions
# ─────────────────────────────────────────────────────────────────────────────


_GIT_SAFE_RULES: list[PresetRule] = [
    PresetRule("Bash(git status*)", description="Working tree status"),
    PresetRule("Bash(git log*)", description="Commit history"),
    PresetRule("Bash(git diff*)", description="Diff working tree / commits"),
    PresetRule("Bash(git show*)", description="Show objects / commits"),
    PresetRule("Bash(git branch*)", description="List / inspect branches"),
    PresetRule("Bash(git remote*)", description="List / inspect remotes"),
    PresetRule("Bash(git stash list*)", description="List stash entries"),
    PresetRule("Bash(git stash show*)", description="Show stash diff"),
    PresetRule("Bash(git tag*)", description="List tags"),
    PresetRule("Bash(git ls-files*)", description="List tracked files"),
    PresetRule("Bash(git blame*)", description="Line-by-line attribution"),
    PresetRule("Bash(git shortlog*)", description="Summarise commit authors"),
    PresetRule(
        "Bash(git fetch*)",
        description="Fetch from remote (network, no local writes)",
        enabled_by_default=False,
    ),
    PresetRule("Bash(git describe*)", description="Describe refs"),
    PresetRule("Bash(git rev-parse*)", description="Parse git refs / hashes"),
    PresetRule("Bash(git cat-file*)", description="Read git objects"),
]


_ANDROID_GRADLE_RULES: list[PresetRule] = [
    PresetRule("Bash(./gradlew tasks*)", description="List available tasks"),
    PresetRule("Bash(./gradlew dependencies*)", description="Dependency tree"),
    PresetRule("Bash(./gradlew projects*)", description="List sub-projects"),
    PresetRule("Bash(./gradlew properties*)", description="Project properties"),
    PresetRule("Bash(./gradlew clean*)", description="Clean build outputs"),
    PresetRule("Bash(./gradlew build*)", description="Full build"),
    PresetRule("Bash(./gradlew assembleDebug*)", description="Assemble debug APK"),
    PresetRule("Bash(./gradlew assembleRelease*)", description="Assemble release APK"),
    PresetRule("Bash(./gradlew bundleDebug*)", description="Build debug AAB"),
    PresetRule("Bash(./gradlew bundleRelease*)", description="Build release AAB"),
    PresetRule("Bash(./gradlew test*)", description="Run unit tests"),
    PresetRule(
        "Bash(./gradlew connectedAndroidTest*)", description="Run instrumented tests"
    ),
    PresetRule("Bash(./gradlew lint*)", description="Run Android lint"),
    PresetRule("Bash(./gradlew ktlintCheck*)", description="ktlint static analysis"),
    PresetRule("Bash(./gradlew detekt*)", description="Detekt static analysis"),
    PresetRule(
        "Bash(./gradlew generateDebugSources*)",
        description="Generate debug sources (KSP/KAPT)",
    ),
    PresetRule("Bash(./gradlew kspDebug*)", description="KSP debug code gen"),
    PresetRule("Bash(./gradlew kspRelease*)", description="KSP release code gen"),
    PresetRule("Bash(gradlew*)", description="Windows wrapper (gradlew without ./)"),
]


BUILTIN_PRESETS: list[PermissionPreset] = [
    PermissionPreset(
        id="git-safe",
        name="Git (safe)",
        description=(
            "Non-destructive git inspection commands. Safe to apply on any "
            "project."
        ),
        icon="🌿",
        category="vcs",
        builtin=True,
        rules=_GIT_SAFE_RULES,
    ),
    PermissionPreset(
        id="android-gradle",
        name="Android Gradle",
        description=(
            "Standard Gradle build, test, and static-analysis tasks for "
            "Android projects."
        ),
        icon="🤖",
        category="build",
        builtin=True,
        rules=_ANDROID_GRADLE_RULES,
    ),
]

_BUILTIN_IDS: set[str] = {p.id for p in BUILTIN_PRESETS}


# ─────────────────────────────────────────────────────────────────────────────
# Registry helpers
# ─────────────────────────────────────────────────────────────────────────────


def _user_preset_from_block(preset_id: str, block: dict) -> PermissionPreset:
    rules_raw = block.get("rules") or []
    rules: list[PresetRule] = []
    for r in rules_raw:
        if isinstance(r, dict):
            rules.append(PresetRule.from_dict(r))
        else:
            rules.append(PresetRule(pattern=str(r)))
    return PermissionPreset(
        id=preset_id,
        name=str(block.get("name", preset_id)),
        description=str(block.get("description", "")),
        icon=str(block.get("icon", "📦")),
        category=str(block.get("category", "custom")),
        builtin=False,
        rules=rules,
    )


def _preset_to_block(preset: PermissionPreset) -> dict:
    """Serialize a user preset to the dict shape stored in registry.yaml."""
    return {
        "name": preset.name,
        "description": preset.description,
        "icon": preset.icon,
        "category": preset.category,
        "rules": [r.to_dict() for r in preset.rules],
    }


def all_presets(registry: dict) -> list[PermissionPreset]:
    """Return built-in presets followed by user-defined presets from the registry."""
    out: list[PermissionPreset] = list(BUILTIN_PRESETS)
    user_block = registry.get("permission_presets") or {}
    if not isinstance(user_block, dict):
        return out
    for preset_id, block in user_block.items():
        if preset_id in _BUILTIN_IDS:
            # User entry collides with a built-in id — skip to keep built-ins
            # authoritative.
            continue
        if not isinstance(block, dict):
            continue
        out.append(_user_preset_from_block(preset_id, block))
    return out


def get_preset(preset_id: str, registry: dict) -> Optional[PermissionPreset]:
    for p in all_presets(registry):
        if p.id == preset_id:
            return p
    return None


def is_builtin(preset_id: str) -> bool:
    return preset_id in _BUILTIN_IDS


# ─────────────────────────────────────────────────────────────────────────────
# Application (rule stamping)
# ─────────────────────────────────────────────────────────────────────────────


def apply_preset(
    preset: PermissionPreset,
    enabled_patterns: Optional[Iterable[str]],
    existing_rules: list[dict],
) -> list[dict]:
    """Append the preset's selected rules to `existing_rules`, deduped on
    `(pattern, kind)`. Returns a new list — does not mutate the input.

    - `enabled_patterns=None` → apply every rule with `enabled_by_default=True`.
    - `enabled_patterns=<iterable>` → apply only rules whose pattern is in
      that set; `enabled_by_default` is ignored.
    """
    if enabled_patterns is None:
        selected = [r for r in preset.rules if r.enabled_by_default]
    else:
        pattern_set = set(enabled_patterns)
        selected = [r for r in preset.rules if r.pattern in pattern_set]

    existing_keys: set[tuple[str, str]] = set()
    out: list[dict] = []
    for r in existing_rules:
        if isinstance(r, dict):
            pat = str(r.get("pattern", ""))
            kind = str(r.get("kind", "allow"))
        else:
            pat = str(r)
            kind = "allow"
        existing_keys.add((pat, kind))
        out.append(r)

    for r in selected:
        key = (r.pattern, r.kind)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        entry: dict = {"pattern": r.pattern, "kind": r.kind}
        out.append(entry)
    return out
