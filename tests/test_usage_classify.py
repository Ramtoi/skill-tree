"""Corpus-driven tests for `usage_classify.py`. Design D2 to D4.

Every `expect` value in the two fixtures this file reads comes from the
design tables, never from running `usage_classify` itself (`tests/AGENTS.md`).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from skill_hub import hub_core
from skill_hub.domain.usage import usage_classify

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


ACTIVITY_CORPUS = _load("usage_activity_corpus.json")
PROJECT_MATCH_CORPUS = _load("usage_project_match_corpus.json")


# ─────────────────────────────────────────────────────────────────────────────
# tool_class
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case", ACTIVITY_CORPUS["tool_class"], ids=[c["name"] for c in ACTIVITY_CORPUS["tool_class"]]
)
def test_tool_class_corpus(case: dict) -> None:
    tool_input = case.get("input", {})
    assert usage_classify.classify_tool(case["tool"], tool_input) == case["expect"]


def test_bash_output_with_no_command_falls_back_to_operate() -> None:
    # `BashOutput`'s own input schema carries no `command` key at all.
    assert usage_classify.classify_tool("BashOutput", {"bash_id": "abc"}) == "operate"


# ─────────────────────────────────────────────────────────────────────────────
# bash_class
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case", ACTIVITY_CORPUS["bash_class"], ids=[c["name"] for c in ACTIVITY_CORPUS["bash_class"]]
)
def test_bash_class_corpus(case: dict) -> None:
    extra_verify = tuple(case.get("extra_verify", ()))
    result = usage_classify.classify_tool(
        "Bash", {"command": case["command"]}, extra_verify=extra_verify
    )
    assert result == case["expect"]


# ─────────────────────────────────────────────────────────────────────────────
# match_project
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case", PROJECT_MATCH_CORPUS["cases"], ids=[c["name"] for c in PROJECT_MATCH_CORPUS["cases"]]
)
def test_match_project_corpus(case: dict) -> None:
    projects = [(name, Path(path)) for name, path in case["projects"]]
    assert usage_classify.match_project(case["cwd"], projects) == case["expect"]


# ─────────────────────────────────────────────────────────────────────────────
# redact_excerpt
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case", ACTIVITY_CORPUS["redaction"], ids=[c["name"] for c in ACTIVITY_CORPUS["redaction"]]
)
def test_redaction_corpus(case: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    # `redact_excerpt` reads `Path.home()` internally (design D2's "home
    # prefix"); each corpus case pins its own home value the same way
    # `tests/conftest.py`'s `_fake_home` patches it, so the case is
    # deterministic regardless of the real machine's home directory.
    home_value = case["home"]
    monkeypatch.setattr(Path, "home", classmethod(lambda cls, _v=home_value: Path(_v)))
    assert usage_classify.redact_excerpt(case["text"]) == case["expect"]


def test_redact_excerpt_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/Users/example")))
    for case in ACTIVITY_CORPUS["redaction"]:
        once = usage_classify.redact_excerpt(case["text"])
        twice = usage_classify.redact_excerpt(once)
        assert once == twice, case["name"]


# ─────────────────────────────────────────────────────────────────────────────
# script_skill_key
# ─────────────────────────────────────────────────────────────────────────────


def _roots_for(tmp_root: Path) -> dict[str, Path]:
    # `data_home()`-derived roots are pinned through `.resolve()` once, up
    # front, and every symlink target and registry `source` this builder
    # writes is derived from that SAME resolved base — so the test is
    # correct even when the OS tmp dir itself sits behind a symlink (macOS
    # `/tmp` -> `/private/tmp`), which `skill_meta.skill_source`'s own
    # `hub_core.expand()` (`Path.resolve()`) would otherwise see and this
    # builder's un-resolved harness-dir roots would not.
    data_home = hub_core.data_home().resolve()
    return {
        "project_skills_dir": tmp_root / "project" / ".claude" / "skills",
        "global_skills_dir": tmp_root / "home" / ".claude" / "skills",
        "data_home_skills": data_home / "skills",
        "data_home_mcp_servers": data_home / "mcp-servers",
    }


def _build_script_case(tmp_root: Path, case: dict) -> tuple[str, dict, list[Path]]:
    roots_by_kind = _roots_for(tmp_root)
    for path in roots_by_kind.values():
        path.mkdir(parents=True, exist_ok=True)

    registry: dict = {"skills": {}}
    for key, spec in case.get("registry", {}).items():
        base = roots_by_kind[spec["source_kind"]]
        registry["skills"][key] = {"source": str(base / spec["source_name"])}

    root_kind = case.get("root_kind")
    if root_kind is None:
        command = case["command_literal"]
    else:
        root = roots_by_kind[root_kind]
        link_path = root / case["link_name"]
        target_kind = case.get("link_target_kind")
        if target_kind is None:
            # A real directory, not a symlink — a canonical `data_home`
            # entry, e.g. `<data_home>/skills/<name>` itself.
            link_path.mkdir(parents=True, exist_ok=True)
        elif target_kind == "variant":
            data_home = hub_core.data_home().resolve()
            variant_dir = data_home / "state" / "skill_variants" / case["link_target_name"]
            variant_dir.mkdir(parents=True, exist_ok=True)
            os.symlink(variant_dir, link_path)
        else:
            target_dir = roots_by_kind[target_kind] / case["link_target_name"]
            target_dir.mkdir(parents=True, exist_ok=True)
            os.symlink(target_dir, link_path)

        token = link_path
        rest = case.get("rest") or ""
        if rest:
            token = token / rest
        command = case["command_template"].format(token=str(token))

    roots = [
        roots_by_kind["project_skills_dir"],
        roots_by_kind["global_skills_dir"],
        roots_by_kind["data_home_skills"],
        roots_by_kind["data_home_mcp_servers"],
    ]
    return command, registry, roots


@pytest.mark.parametrize(
    "case",
    ACTIVITY_CORPUS["script_path_to_key"],
    ids=[c["name"] for c in ACTIVITY_CORPUS["script_path_to_key"]],
)
def test_script_skill_key_corpus(case: dict, tmp_data_home: Path) -> None:
    command, registry, roots = _build_script_case(tmp_data_home, case)
    assert usage_classify.script_skill_key(command, registry, roots) == case["expect"]


@pytest.mark.parametrize(
    ("root_text", "command_token", "target_text", "source_text"),
    [
        (
            r"D:\Work\Repo\.claude\skills",
            r"d:\work\repo\.claude\skills\unslop\scripts\foo.sh",
            r"D:\Skill-Real\Unslop",
            r"d:/skill-real/unslop",
        ),
        (
            r"\\Server\Share\.claude\skills",
            r"//server\share/.claude/skills\unslop/scripts/foo.sh",
            r"\\Server\Share\Skill-Real\Unslop",
            r"//server/share/skill-real/unslop",
        ),
        (
            r"D:\Work\Repo\.claude\skills",
            r"d:\work\repo\.claude\skills\unslop\scripts\foo.sh",
            r"\\?\D:\Skill-Real\Unslop",
            r"d:/skill-real/unslop",
        ),
        (
            r"\\Server\Share\.claude\skills",
            r"//server\share/.claude/skills\unslop/scripts/foo.sh",
            r"\\?\UNC\Server\Share\Skill-Real\Unslop",
            r"//server/share/skill-real/unslop",
        ),
    ],
    ids=(
        "drive-mixed-separators-and-case",
        "unc-mixed-separators-and-case",
        "extended-drive-target",
        "extended-unc-target",
    ),
)
def test_script_skill_key_accepts_windows_spelling_on_all_hosts(
    root_text: str,
    command_token: str,
    target_text: str,
    source_text: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_data_home: Path,
) -> None:
    # These are command and registry spellings captured on Windows. The
    # symlink target is mocked because synthetic drive and UNC paths cannot
    # exist on every host; the public classifier still performs its normal
    # root, relative-path, and registry-source comparisons.
    root = Path(root_text)
    resolved_links: list[Path] = []

    def _link_target(link_path: Path) -> Path:
        resolved_links.append(link_path)
        return Path(target_text)

    monkeypatch.setattr(
        usage_classify.sync_links,
        "link_target_abs",
        _link_target,
    )
    monkeypatch.setattr(
        usage_classify.skill_meta,
        "skill_source",
        lambda cfg: Path(cfg["source"]),
    )
    registry = {"skills": {"unslop": {"source": source_text}}}

    assert usage_classify.script_skill_key(f"bash {command_token}", registry, [root]) == "unslop"
    assert resolved_links == [root / "unslop"]


def test_script_skill_key_resolves_a_real_symlink_target(
    tmp_data_home: Path, tmp_path: Path
) -> None:
    target = tmp_path / "skill-real" / "unslop"
    (target / "scripts").mkdir(parents=True)
    (target / "scripts" / "foo.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    root = tmp_path / "project" / ".claude" / "skills"
    root.mkdir(parents=True)
    link = root / "unslop"
    link.symlink_to(target)
    registry = {"skills": {"unslop": {"source": str(target)}}}

    if os.name == "nt":
        assert os.readlink(link).startswith("\\\\?\\")
    assert usage_classify.script_skill_key(
        f"bash {root}/unslop/scripts/foo.sh", registry, [root]
    ) == "unslop"


def test_script_skill_key_respects_native_separator_behavior(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    token = f"{root}\\unslop/scripts/foo.sh"
    registry = {"skills": {"unslop": {"source": str(root / "unslop")}}}

    expected = "unslop" if os.name == "nt" else None
    assert usage_classify.script_skill_key(f"bash {token}", registry, [root]) == expected


def test_text_skill_mentions_keeps_only_registered_keys_and_counts_unique_mentions():
    registry = {"skills": {"alpha": {}, "beta": {}}}
    facts = usage_classify.text_skill_mentions(
        "skills/alpha/SKILL.md skills/alpha/ skills/unregistered/ skills/beta/", registry
    )
    assert facts.registered_keys == ("alpha", "beta")
    assert facts.mention_count == 3
