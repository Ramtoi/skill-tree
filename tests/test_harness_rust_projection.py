"""The native bridge must consume Python selection rather than select again."""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

BYPASS_LITERALS = (
    "harnesses::registry()",
    "harnesses::detected_installed()",
    "META_CACHE",
    "EMBEDDED_SCHEMA",
    '"--version"',
    "fn which(",
)


def _found_bypasses(source: str) -> list[str]:
    """The scan itself: which of BYPASS_LITERALS appear verbatim in `source`."""
    return [bypass for bypass in BYPASS_LITERALS if bypass in source]


@pytest.mark.parametrize("module", ["harnesses", "agent_docs", "global_docs"])
def test_rust_native_selection_has_no_independent_inventory(module):
    path = ROOT / "app" / "src-tauri" / "src" / "commands" / f"{module}.rs"
    source = path.read_text()
    assert source, f"{path} read as empty"
    found = _found_bypasses(source)
    assert not found, f"{module} bypasses the Python operation context: {found}"


@pytest.mark.parametrize("bypass", BYPASS_LITERALS)
def test_bypass_scan_flags_a_reintroduced_bypass(bypass):
    """Positive control: the scan above is a pure negative text match with no
    proof it can ever fire. Run the exact same `_found_bypasses` helper
    against a fixture string carrying each literal, so a future change to
    the scan mechanics (e.g. swapping the `in` check for a stricter matcher)
    cannot silently stop flagging a real bypass."""
    fixture_source = f"// reintroduced bypass\nlet x = {bypass};\n"
    assert _found_bypasses(fixture_source) == [bypass]


def test_build_no_longer_generates_an_unused_native_harness_registry():
    source = (ROOT / "app" / "src-tauri" / "build.rs").read_text()
    assert "harnesses.generated.json" not in source


def _projection_context(tmp_data_home, tmp_path, monkeypatch, identities=()):
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context as contexts
    from skill_hub.application.harnesses.harness_runtime import RuntimeInventory

    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: RuntimeInventory(tuple(identities), "fixed"))
    context = contexts.build_operation_context(
        tmp_data_home,
        ("codex",),
        requested_features=("invocation", "hooks", "agent_docs", "subagents"),
        installed_harness_ids=("codex",),
    )
    doc = tmp_path / "captured" / "AGENTS.md"
    doc.parent.mkdir()
    doc.write_text("captured instructions")
    layout = replace(context.layout("codex"), global_doc=doc, config_dir=tmp_path / "captured")
    return replace(context, layouts={"codex": layout})


def test_harness_list_projects_only_fixed_layout_and_identity(tmp_data_home, tmp_path, monkeypatch, capsys):
    import argparse
    import json

    from skill_hub.application.harnesses import harness_operation_context as contexts
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.entrypoints.cli import harness
    from skill_hub.infrastructure.harnesses import harnesses

    identity = RuntimeIdentity(
        harness_id="codex",
        installation_id="fixed",
        raw_version="0.1.0",
        version=Version(0, 1, 0),
        os_name="linux",
        architecture="x86_64",
        executable_path=str(tmp_path / "codex"),
        evidence="fixture",
    )
    context = _projection_context(tmp_data_home, tmp_path, monkeypatch, (identity,))
    calls = []

    def build(*args, **kwargs):
        calls.append(kwargs)
        # A changed registry after capture cannot change the operation's rows.
        monkeypatch.setattr(harnesses, "HARNESSES", {})
        return context

    monkeypatch.setattr(contexts, "build_operation_context", build)
    harness.cmd_harness_list(argparse.Namespace(json=True, probe=False))
    rows = json.loads(capsys.readouterr().out)
    assert len(calls) == 1
    assert not calls[0]["needs_selection"]
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "codex"
    assert row["path"] == identity.executable_path
    assert row["version"] == "0.1.0"
    assert row["config_dir"] == str(tmp_path / "captured")
    assert row["global_doc"] == str(tmp_path / "captured" / "AGENTS.md")
    assert row["global_doc_exists"]
    assert row["agents"]["project_agents_dir"] is None


@pytest.mark.parametrize("state,count", [("stale", 1), ("fresh", 2), ("missing", 0)])
def test_harness_projection_never_guesses_executable_or_version(
    tmp_data_home, tmp_path, monkeypatch, capsys, state, count
):
    import argparse
    import json
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context as contexts
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.entrypoints.cli import harness

    identities = tuple(
        RuntimeIdentity(
            harness_id="codex",
            installation_id=str(index),
            raw_version="0.1.0",
            version=Version(0, 1, 0),
            os_name="linux",
            architecture="x86_64",
            executable_path=str(tmp_path / f"codex-{index}"),
            evidence="fixture",
        )
        for index in range(count)
    )
    context = replace(
        _projection_context(tmp_data_home, tmp_path, monkeypatch, identities), inventory_cache_state=state
    )
    monkeypatch.setattr(contexts, "build_operation_context", lambda *args, **kwargs: context)
    harness.cmd_harness_list(argparse.Namespace(json=True, probe=False))
    row = json.loads(capsys.readouterr().out)[0]
    assert row["path"] is None
    assert row["version"] is None


def test_doc_projection_uses_supplied_context_and_keeps_missing_route_unavailable(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    import argparse
    import json
    from dataclasses import replace

    from skill_hub.entrypoints.cli import harness

    context = _projection_context(tmp_data_home, tmp_path, monkeypatch)
    args = argparse.Namespace(harness="codex", json=True, _operation_context=context)
    harness.cmd_harness_doc_resolve(args)
    row = json.loads(capsys.readouterr().out)
    assert row["harness_id"] == "codex"
    assert row["path"] == str(context.layout("codex").global_doc)
    assert row.get("error") is None
    args._operation_context = replace(context, routes={})
    harness.cmd_harness_doc_resolve(args)
    row = json.loads(capsys.readouterr().out)
    assert row["path"] is None
    assert row["error"]
