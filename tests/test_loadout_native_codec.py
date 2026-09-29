"""Native delivery is reviewed, portable, and part of the signed transaction."""

import ast
import json
from dataclasses import asdict, replace
from pathlib import Path

import pytest
from test_loadout_receive import scenario as receiver_scenario

from skill_hub.domain.harnesses.harness_adapter_api import CatalogSnapshot
from skill_hub.domain.harnesses.harness_catalog import build_catalog_snapshot, bundled_catalog, manifest_content_digest
from skill_hub.domain.loadout.loadout_native_codec import (
    LoadoutCodecContext,
    capture_loadout_codec_context,
    compile_units,
    render_unit,
    validate_payload,
)
from skill_hub.domain.loadout.loadout_profiles import ProfileError
from skill_hub.domain.mcp.mcp_spec import McpServerSpec

scenario = receiver_scenario


def _context():
    return capture_loadout_codec_context()


class _RecordingCodec:
    def __init__(self, inner, area, calls):
        self.inner = inner
        self.area = area
        self.calls = calls

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def encode(self, request):
        self.calls.add(f"{self.area}.encode")
        return self.inner.encode(request)

    def parse(self, text):
        self.calls.add(f"{self.area}.parse")
        return self.inner.parse(text)

    def render(self, request):
        self.calls.add(f"{self.area}.render")
        return self.inner.render(request)

    def validation_error(self, pattern):
        self.calls.add(f"{self.area}.validation_error")
        return self.inner.validation_error(pattern)


class _RejectingCodec(_RecordingCodec):
    def __init__(self, inner, area, calls, method):
        super().__init__(inner, area, calls)
        self.method = method

    def _reject(self, method):
        if self.method == method:
            self.calls.add(f"{self.area}.{method}")
            raise ProfileError("sentinel_codec_rejected", f"sentinel {self.area} codec rejected {method}")

    def encode(self, request):
        self._reject("encode")
        return super().encode(request)

    def parse(self, text):
        self._reject("parse")
        return super().parse(text)

    def render(self, request):
        self._reject("render")
        return super().render(request)

    def validation_error(self, pattern):
        self._reject("validation_error")
        return super().validation_error(pattern)


class _ChangingHookCodec:
    def __init__(self, inner):
        self.inner = inner

    def encode(self, request):
        result = self.inner.encode(request)
        if result.entry is None:
            return result
        return replace(result, entry=replace(result.entry, matcher="sentinel:" + result.entry.matcher))


def _recording_context(calls):
    base = _context()

    def wrap(mapping, area):
        return {key: _RecordingCodec(codec, area, calls) for key, codec in mapping.items()}

    return LoadoutCodecContext(
        mcp=wrap(base.mcp, "mcp"),
        hooks=wrap(base.hooks, "hooks"),
        permissions=wrap(base.permissions, "permissions"),
        permission_patterns=wrap(base.permission_patterns, "permissions"),
        agents=wrap(base.agents, "agents"),
        capability=dict(base.capability),
        provenance=dict(base.provenance),
        catalog=base.catalog,
    )


def test_loadout_codec_context_freezes_capability_and_provenance_snapshots():
    capability = {"schema": 2, "nested": {"status": "verified"}}
    provenance = {"release": {"version": "1.0"}}
    context = capture_loadout_codec_context(capability=capability, provenance=provenance)
    capability["nested"]["status"] = "changed"
    provenance["release"]["version"] = "2.0"
    assert context.capability["nested"]["status"] == "verified"
    assert context.provenance["release"]["version"] == "1.0"
    with pytest.raises(TypeError):
        context.capability["schema"] = 3
    for mapping in (context.mcp, context.hooks, context.permissions, context.permission_patterns, context.agents):
        with pytest.raises(TypeError):
            mapping["replacement"] = object()


def _catalog_for_features(features, *, active=True, staged=False, selected=None) -> CatalogSnapshot:
    base = bundled_catalog().manifests[0]
    variant = replace(
        base.variants[0],
        features=features,
        validation_evidence={name: "fixture evidence" for name, value in features.items() if value == "verified"},
    )
    manifest = replace(base, variants=(variant,), active=active, staged=staged, digest="pending")
    manifest = replace(manifest, digest=manifest_content_digest(manifest))
    selected = (manifest.release_id,) if selected is None and active and not staged else (selected or ())
    return build_catalog_snapshot((manifest,), generation="fixture", active_release_ids=selected)


@pytest.mark.parametrize("features, active, staged, rejected", [
    ({"loadout_mcp": "verified"}, True, False, True),
    ({"loadout_permissions": "unverified"}, True, False, True),
    ({"loadout_hooks": "unsupported"}, True, False, False),
    ({"loadout_agents": False}, True, False, False),
    ({"loadout_hooks": "verified"}, False, False, False),
    ({"loadout_agents": "verified"}, True, True, False),
    ({"invocation": "verified"}, True, False, False),
])
def test_loadout_feature_predicate_uses_typed_active_catalog(features, active, staged, rejected):
    catalog = _catalog_for_features(features, active=active, staged=staged)
    if rejected:
        with pytest.raises(ProfileError, match="loadout feature"):
            capture_loadout_codec_context(catalog=catalog)
    else:
        assert capture_loadout_codec_context(catalog=catalog).catalog is catalog


def test_loadout_feature_on_unselected_active_manifest_is_not_authority():
    catalog = _catalog_for_features({"loadout_mcp": "verified"}, selected=())
    assert catalog.active_release_ids == ()
    assert capture_loadout_codec_context(catalog=catalog).catalog is catalog


def test_codec_context_construction_and_required_context_calls_stay_at_operation_boundaries():
    root = Path(__file__).resolve().parents[1]
    native_tree = ast.parse((root / "skill_hub/domain/loadout/loadout_native_codec.py").read_text())
    definitions = {
        node.name: node
        for node in ast.walk(native_tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    constructors = [
        node for node in ast.walk(native_tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "LoadoutCodecContext"
    ]
    factory_constructors = [
        node for node in ast.walk(definitions["capture_loadout_codec_context"])
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "LoadoutCodecContext"
    ]
    assert len(constructors) == 1 and constructors == factory_constructors
    bundled_names = {
        "bundled_agent_codec",
        "bundled_hook_codec",
        "bundled_mcp_codec",
        "bundled_pattern_codec",
        "bundled_permission_codec",
    }
    bundled_calls = [
        node for node in ast.walk(native_tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in bundled_names
    ]
    factory_bundled_calls = [
        node for node in ast.walk(definitions["capture_loadout_codec_context"])
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in bundled_names
    ]
    assert bundled_calls and bundled_calls == factory_bundled_calls
    assert definitions["capabilities"].args.args[-1].arg == "context"
    for name in ("compile_units", "permission_payload", "render_unit"):
        context_arg = next(arg for arg in definitions[name].args.kwonlyargs if arg.arg == "context")
        index = definitions[name].args.kwonlyargs.index(context_arg)
        assert definitions[name].args.kw_defaults[index] is None

    for node in ast.walk(native_tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "permission_payload":
            assert any(keyword.arg == "context" for keyword in node.keywords), node.lineno

    for relative in (
        "skill_hub/domain/loadout/loadout_projection.py",
        "skill_hub/application/loadout/loadout_publish.py",
        "skill_hub/application/loadout/loadout_receive.py",
        "skill_hub/entrypoints/cli/receive.py",
    ):
        tree = ast.parse((root / relative).read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id in {"compile_units", "render_unit"}:
                assert any(keyword.arg == "context" for keyword in node.keywords), (relative, node.lineno)
            if node.func.id == "capabilities":
                assert len(node.args) == 1, (relative, node.lineno)


def test_production_catalog_rejection_precedes_bundled_codec_construction(monkeypatch):
    catalog = _catalog_for_features({"loadout_hooks": "verified"})
    monkeypatch.setattr("skill_hub.domain.harnesses.harness_catalog.bundled_catalog", lambda: catalog)
    from skill_hub.infrastructure.harnesses import harness_bundled_mcp

    monkeypatch.setattr(
        harness_bundled_mcp, "bundled_codec", lambda _: pytest.fail("codec construction must be guarded")
    )
    with pytest.raises(ProfileError) as error:
        capture_loadout_codec_context()
    assert error.value.code == "loadout_adapter_binding_required"


def test_default_context_composes_every_native_codec_area():
    context = capture_loadout_codec_context()
    assert context.codec("mcp", "codex")
    assert context.codec("hooks", "claude-code")
    assert context.codec("permissions", "codex")
    assert context.codec("permission_patterns", "claude-code")
    assert context.codec("agents", "codex")


def claude(scenario):
    receiver, publish, checkout, source, registry, target = scenario
    receiver.installed = {"claude-code"}
    binding = target.project_bindings["main"]
    binding["harnesses"] = ["claude-code"]
    binding["confirmation"] = receiver.profiles.confirm("main", binding, checkout, installed={"claude-code"})
    return receiver, publish, checkout, source, registry, target


def test_signed_native_mcp_and_permissions_require_approval_preserve_unknown_and_block_drift(scenario):
    receiver, publish, checkout, _, registry, _ = scenario
    registry["skills"]["search"] = {"type": "mcp-server", "mcp": {"command": "python3", "args": ["-m", "example"]}}
    registry["projects"]["app"]["enabled"].append("search")
    registry["projects"]["app"]["permissions"] = {"allow": ["Bash(git status:*)"]}
    config = checkout / ".codex/config.toml"
    config.parent.mkdir()
    config.write_text('# server settings\nmodel = "existing"\n')
    revision = publish()
    preview = receiver.plan()
    assert preview["state"] == "approval_required", preview
    assert "mcp_servers" not in config.read_text()
    receiver.approve(preview["approval_digest"])
    result = receiver.once(revision)
    assert result["state"] == "applied", result
    assert "# server settings" in config.read_text() and "existing" in config.read_text()
    assert "[mcp_servers.search]" in config.read_text()
    assert (checkout / ".codex/rules/skill-tree-project.rules").exists()
    assert result["applied"]["schema"] == 2 and result["applied"]["native_files"]
    assert receiver.once()["state"] == "unchanged"
    config.write_text(config.read_text().replace("python3", "server-edited"))
    assert receiver.once()["state"] == "blocked_drift"
    assert "server-edited" in config.read_text()


def test_claude_companion_hook_agent_and_permission_are_one_approved_delivery(scenario):
    receiver, publish, checkout, source, registry, _ = claude(scenario)
    (source / "scripts").mkdir()
    (source / "scripts/check.sh").write_text("echo reviewed\n")
    (source / "agents").mkdir()
    (source / "agents/reviewer.md").write_text(
        "---\nname: reviewer\ndescription: Review changes\n---\nRead the diff.\n"
    )
    (source / "SKILL.md").write_text("""---
name: example
description: Example
ships_with:
  agents: [reviewer]
  hooks:
    - name: check
      event: Stop
      command: scripts/check.sh
  permissions:
    allow: ["Bash(git status:*)"]
---
Example
""")
    revision = publish()
    preview = receiver.plan()
    assert preview["state"] == "approval_required", preview
    receiver.approve(preview["approval_digest"])
    assert receiver.once(revision)["state"] == "applied"
    settings = json.loads((checkout / ".claude/settings.json").read_text())
    assert settings["permissions"]["allow"] == ["Bash(git status:*)"]
    hooks = json.loads((checkout / ".claude/settings.local.json").read_text())
    command = hooks["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert str(checkout / ".claude/hooks/skill-tree-example-check.sh") in command
    assert (checkout / ".claude/agents/reviewer.md").exists()
    # Script authority changes cannot ride an ordinary skills-only refresh.
    (source / "scripts/check.sh").write_text("echo changed\n")
    publish(2, revision)
    assert receiver.once()["state"] == "approval_required"
    assert (checkout / ".claude/hooks/skill-tree-example-check.sh").read_text() == "echo reviewed\n"


def test_recorded_codecs_influence_controller_publication_and_receiver_rendering(scenario, monkeypatch):
    receiver, publish, checkout, source, registry, _ = claude(scenario)
    (source / "scripts").mkdir()
    (source / "scripts/check.sh").write_text("echo reviewed\n")
    (source / "agents").mkdir()
    (source / "agents/reviewer.md").write_text(
        "---\nname: reviewer\ndescription: Review changes\n---\nRead the diff.\n"
    )
    (source / "SKILL.md").write_text(
        "---\nname: example\ndescription: Example\nships_with:\n"
        "  agents: [reviewer]\n  hooks:\n    - name: check\n"
        "      event: Stop\n      command: scripts/check.sh\n"
        "  permissions:\n    allow: [\"Bash(git status:*)\"]\n---\nExample\n"
    )
    registry["skills"]["search"] = {
        "type": "mcp-server", "source": str(source), "mcp": {"command": "python3"},
    }
    registry["projects"]["app"]["enabled"].append("search")
    calls = set()
    context = _recording_context(calls)
    revision = publish(codec_context=context)
    assert calls == {"mcp.encode", "hooks.encode", "permissions.encode", "agents.parse"}
    from skill_hub.domain.loadout import loadout_native_codec

    monkeypatch.setattr(loadout_native_codec, "capture_loadout_codec_context", lambda: context)
    calls.clear()
    preview = receiver.plan()
    assert preview["state"] == "approval_required"
    assert calls == {
        "mcp.encode",
        "hooks.encode",
        "permissions.validation_error",
        "agents.render",
    }
    receiver.approve(preview["approval_digest"])
    calls.clear()
    assert receiver.once(revision)["state"] == "applied"
    assert calls == {
        "mcp.encode",
        "hooks.encode",
        "permissions.validation_error",
        "agents.render",
    }

    hooks = dict(context.hooks)
    hooks["claude-code"] = _ChangingHookCodec(hooks["claude-code"])
    changing = replace(context, hooks=hooks)
    changed_revision = publish(2, revision, changing)
    channel = receiver._channel()
    feed = receiver._feed(channel)
    assert feed.fetch() == changed_revision
    projection, assets = feed.read(changed_revision, channel["pubkey"])
    hook_unit = next(unit for unit in projection["bindings"]["main"]["native"] if unit["area"] == "hooks")
    assert json.loads(assets[hook_unit["asset"]])["matcher"] == "sentinel:"
    monkeypatch.setattr(loadout_native_codec, "capture_loadout_codec_context", lambda: changing)
    preview = receiver.plan()
    assert preview["state"] == "approval_required"
    receiver.approve(preview["approval_digest"])
    assert receiver.once(changed_revision)["state"] == "applied"
    settings = json.loads((checkout / ".claude/settings.local.json").read_text())
    assert settings["hooks"]["Stop"][0]["matcher"] == "sentinel:sentinel:"

    controller_methods = (
        ("mcp", "mcp", "encode"),
        ("hooks", "hooks", "encode"),
        ("permissions", "permission_patterns", "encode"),
        ("agents", "agents", "parse"),
    )
    for area, field, method in controller_methods:
        values = dict(getattr(context, field))
        values["claude-code"] = _RejectingCodec(values["claude-code"], area, set(), method)
        rejecting = replace(context, **{field: values})
        with pytest.raises(ProfileError, match=f"sentinel {area} codec rejected {method}"):
            publish(3, changed_revision, rejecting)

    receiver_methods = (
        ("mcp", "mcp", "encode"),
        ("hooks", "hooks", "encode"),
        ("permissions", "permission_patterns", "validation_error"),
        ("agents", "agents", "render"),
    )
    for area, field, method in receiver_methods:
        values = dict(getattr(context, field))
        values["claude-code"] = _RejectingCodec(values["claude-code"], area, set(), method)
        rejecting = replace(context, **{field: values})
        monkeypatch.setattr(loadout_native_codec, "capture_loadout_codec_context", lambda: rejecting)
        assert receiver.plan()["state"] == "sentinel_codec_rejected"


def test_compile_units_attached_hook_emits_translated_string_matcher(scenario):
    receiver, _, _, _, registry, target = claude(scenario)
    registry["hooks"] = {
        "guard": {
            "event": "PreToolUse",
            "tools": ["Edit"],
            "command": "echo reviewed",
        }
    }
    registry["projects"]["app"]["hooks"] = ["guard"]
    project = registry["projects"]["app"]
    binding = target.project_bindings["main"]
    assets: dict[str, bytes] = {}
    units = compile_units(
        registry, project, binding, ["example"], assets, {"example": {}}, context=_context(),
    )
    hook_unit = next(unit for unit in units if unit["area"] == "hooks")
    payload = json.loads(assets[hook_unit["asset"]])
    assert payload["event"] == "PreToolUse"
    assert isinstance(payload["matcher"], str)
    assert payload["matcher"]


def test_global_native_opt_in_and_reconfirmation(scenario):
    receiver, publish, checkout, _, registry, target = claude(scenario)
    registry["permissions_global"] = {"deny": ["Bash(rm:*)"]}
    first = publish()
    assert receiver.once(first)["state"] == "applied"
    global_file = receiver.home / ".claude/settings.json"
    assert not global_file.exists()
    binding = target.project_bindings["main"]
    binding["global_native"] = ["permissions"]
    with pytest.raises(ProfileError):
        publish(2, first)
    binding["confirmation"] = receiver.profiles.confirm("main", binding, checkout, installed={"claude-code"})
    second = publish(2, first)
    preview = receiver.plan()
    assert preview["state"] == "approval_required", preview
    receiver.approve(preview["approval_digest"])
    assert receiver.once(second)["state"] == "applied"
    assert json.loads(global_file.read_text())["permissions"]["deny"] == ["Bash(rm:*)"]


def test_disabled_source_global_mcp_is_not_reintroduced_by_native_codec(scenario):
    receiver, publish, checkout, _, registry, target = claude(scenario)
    registry["sources"] = {"team": {"enabled": False}}
    registry["skills"]["disabled-search"] = {
        "type": "mcp-server",
        "scope": "global",
        "managed": "external",
        "origin": {"source": "team"},
        "mcp": {"command": "python3", "args": ["-m", "example"]},
    }
    binding = target.project_bindings["main"]
    binding["global_native"] = ["mcp"]
    binding["confirmation"] = receiver.profiles.confirm("main", binding, checkout, installed={"claude-code"})
    revision = publish()
    assert receiver.once(revision)["state"] == "applied"
    assert not (receiver.home / ".claude.json").exists()


@pytest.mark.parametrize(
    "change",
    [
        {"command": "/Users/me/server"},
        {"env": {"API_TOKEN": "literal-secret-token"}},
        {"transport": "http", "url": "https://user:secret@example.com"},
        {"args": ["/home/me/server.py"]},
    ],
)
def test_controller_paths_and_secrets_are_rejected(change):
    spec = asdict(McpServerSpec("search", command="python3"))
    spec.update(change)
    with pytest.raises(ProfileError):
        validate_payload("mcp", {"version": 1, "spec": spec})


def test_codec_rejects_unknown_fields_and_codex_project_hook(tmp_data_home):
    payload = {
        "version": 1,
        "event": "Stop",
        "matcher": "",
        "timeout": None,
        "interpreter": "bash",
        "args": [],
        "script": "echo reviewed\n",
    }
    with pytest.raises(ProfileError):
        validate_payload("hooks", {**payload, "write_path": "/tmp/evil"})
    unit = {"scope": "project", "harness": "codex", "area": "hooks", "key": "check", "asset": "irrelevant"}
    limitations = []
    operations, files = render_unit(
        unit, payload, tmp_data_home, tmp_data_home, "main", {}, limitations=limitations, context=_context()
    )
    assert operations == [] and files == {}
    assert limitations[0]["area"] == "hooks"
    assert "unsupported" in limitations[0]["message"]


def test_global_codex_underscore_agent_and_portability(scenario, monkeypatch, tmp_data_home):
    from pathlib import Path

    receiver, publish, checkout, _, registry, target = scenario
    registry["skills"]["example"]["scope"] = "global"
    controller_home = tmp_data_home / "controller"
    agent_dir = controller_home / ".codex/agents"
    agent_dir.mkdir(parents=True)
    agent = agent_dir / "pr_explorer.toml"
    agent.write_text(
        f'name="pr_explorer"\ndescription="Review"\ndeveloper_instructions="Read the diff"\n'
        f'[[skills.config]]\npath = "{controller_home}/.agents/skills/example/SKILL.md"\n'
        "enabled = true\n"
    )
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: controller_home))
    monkeypatch.setenv("HOME", str(controller_home))
    binding = target.project_bindings["main"]
    binding.update(global_native=["agents"], global_agents=["pr_explorer"])
    binding["confirmation"] = receiver.profiles.confirm("main", binding, checkout, installed={"codex"})
    revision = publish()
    preview = receiver.plan()
    assert preview["state"] == "approval_required", preview
    receiver.approve(preview["approval_digest"])
    assert receiver.once(revision)["state"] == "applied"
    assert (receiver.home / ".codex/agents/pr_explorer.toml").exists()
    delivered = (receiver.home / ".codex/agents/pr_explorer.toml").read_text()
    assert str(receiver.home / ".agents/skills/example/SKILL.md") in delivered
    agent.write_text(
        'name="pr_explorer"\ndescription="Review"\n[[skills.config]]\n'
        'path = "/foreign/skills/SKILL.md"\nenabled = true\n'
    )
    with pytest.raises(ProfileError, match="unportable skill references"):
        publish(2, revision)
    agent.write_text(
        'name="pr_explorer"\ndescription="Review"\ndeveloper_instructions="Read /Users/controller/private"\n'
    )
    with pytest.raises(ProfileError) as error:
        publish(2, revision)
    assert error.value.code == "native_unportable_path"


def test_hook_source_paths_are_blocked_but_environment_references_are_portable():
    payload = {
        "version": 1,
        "event": "Stop",
        "matcher": "",
        "timeout": None,
        "interpreter": "bash",
        "args": [],
        "script": "cd /Users/controller/project\n",
    }
    with pytest.raises(ProfileError) as error:
        validate_payload("hooks", payload)
    assert error.value.code == "native_unportable_path"
    payload["script"] = 'echo "$TOKEN"\n'
    assert validate_payload("hooks", payload) == payload


def test_codex_mcp_partial_headers_are_rendered_and_sse_is_omitted(tmp_data_home):
    from skill_hub.domain.mcp.mcp_spec import McpServerSpec

    partial = {
        "version": 1,
        "spec": asdict(
            McpServerSpec(
                "search",
                transport="http",
                url="https://example.com/mcp",
                headers={"X-Static": "ok", "X-Dynamic": "prefix ${TOKEN}"},
            )
        ),
    }
    limitations = []
    operations, files = render_unit(
        {"scope": "project", "harness": "codex", "area": "mcp", "key": "search", "asset": "x"},
        partial,
        tmp_data_home,
        tmp_data_home,
        "main",
        {},
        check_prerequisites=False,
        limitations=limitations,
        context=_context(),
    )
    assert files == {}
    assert operations[0].value["http_headers"] == {"X-Static": "ok"}
    assert any("codex_header_not_representable" in row["message"] for row in limitations)

    sse = partial.copy()
    sse["spec"] = asdict(McpServerSpec("events", transport="sse", url="https://example.com/events"))
    limitations = []
    operations, files = render_unit(
        {"scope": "project", "harness": "codex", "area": "mcp", "key": "events", "asset": "x"},
        sse,
        tmp_data_home,
        tmp_data_home,
        "main",
        {},
        check_prerequisites=False,
        limitations=limitations,
        context=_context(),
    )
    assert operations == [] and files == {}
    assert limitations[0]["message"].endswith("codex_no_sse")


def test_compile_collects_codex_permission_risks_without_dropping_unit(tmp_data_home):
    limitations = []
    units = compile_units(
        {"skills": {}, "permissions_global": {}, "hooks_global": []},
        {
            "path": str(tmp_data_home),
            "permissions": {"allow": ["Bash(git status:*)"], "deny": ["Read(*)"], "ask": ["Bash(*)"]},
        },
        {"harnesses": ["codex"], "global_native": [], "global_agents": [], "destination_key": "main"},
        [],
        {},
        {},
        limitations=limitations,
        context=_context(),
    )
    assert [unit["area"] for unit in units] == ["permissions"]
    assert {row["risk"] for row in limitations} == {"dropped_deny_or_ask"}
    assert any("Read(*)" in row["message"] for row in limitations)


def test_codex_permission_render_adds_receiver_checkout_trust_and_reports_risks(tmp_data_home):
    checkout = tmp_data_home / "somewhere" / "project"
    payload = {
        "version": 1,
        "allow": ["Bash(git status:*)"],
        "deny": ["Read(*)"],
        "ask": ["Bash(*)"],
        "sandbox_mode": None,
        "approval_policy": None,
    }
    limitations = []
    operations, files = render_unit(
        {"scope": "project", "harness": "codex", "area": "permissions", "key": "project", "asset": "x"},
        payload,
        checkout,
        tmp_data_home,
        "main",
        {},
        limitations=limitations,
        context=_context(),
    )
    trust = next(operation for operation in operations if operation.selector[-1] == "trust_level")
    assert str(checkout) in trust.selector
    assert trust.path == tmp_data_home / ".codex/config.toml"
    assert all(path.is_relative_to(checkout) for path in files)
    assert files
    assert len(limitations) == 2
    assert all(row["risk"] == "dropped_deny_or_ask" for row in limitations)


def test_receiver_preview_and_apply_report_omitted_codex_sse_without_blocking(scenario):
    receiver, publish, checkout, _, registry, _ = scenario
    registry["skills"]["events"] = {
        "type": "mcp-server",
        "mcp": {"transport": "sse", "url": "https://example.com/events"},
    }
    registry["projects"]["app"]["enabled"].append("events")
    revision = publish()
    preview = receiver.plan()
    assert preview["ok"]
    assert any(row["message"].endswith("codex_no_sse") for row in preview["limitations"])
    result = receiver.once(revision)
    assert result["state"] == "applied"
    assert any(row["message"].endswith("codex_no_sse") for row in result["limitations"])
    assert not (checkout / ".codex/config.toml").exists()


@pytest.mark.parametrize("trust", ["true", 1, [], {}])
def test_permission_payload_rejects_malformed_trust(trust):
    with pytest.raises(ProfileError, match="project trust"):
        validate_payload("permissions", {"version": 1, "allow": [], "deny": [], "ask": [],
                        "sandbox_mode": None, "approval_policy": None, "project_trust": trust})


def test_managed_python_hook_allows_prose_slash_but_rejects_absolute_paths():
    from skill_hub.domain.loadout.loadout_native_codec import validate_payload

    payload = {
        'version': 1, 'event': 'UserPromptSubmit', 'matcher': '', 'timeout': None,
        'interpreter': 'python3', 'args': [],
        'script': 'print("re-read the task list / loop state")\n',
    }
    assert validate_payload('hooks', payload) == payload
    awk = "awk '/^## Open/{f=1;next}/^## Archive/{f=0}f&&/^### /{c++}END{print c+0}' file"
    assert validate_payload('hooks', {**payload, 'script': awk})['script'] == awk
    for source in ['open("/Users/example/private")', 'cat /etc/passwd', 'cd ~/private']:
        with pytest.raises(ProfileError, match='portable'):
            validate_payload('hooks', {**payload, 'script': source})
    with pytest.raises(ProfileError, match='portable'):
        validate_payload('hooks', {**payload, 'args': ['/']})


def test_claude_companion_advanced_metadata_survives_approved_delivery(scenario):
    receiver, publish, checkout, source, registry, _ = claude(scenario)
    (source / "agents").mkdir()
    (source / "agents/reviewer.md").write_text(
        "---\nname: reviewer\ndescription: Review changes\ntier: careful\n---\nRead the diff.\n"
    )
    (source / "SKILL.md").write_text(
        "---\nname: example\ndescription: Example\nships_with:\n  agents: [reviewer]\n---\nExample\n"
    )
    revision = publish()
    plan = receiver.plan()
    assert plan["state"] == "approval_required", plan
    receiver.approve(plan["approval_digest"])
    assert receiver.once(revision)["state"] == "applied"
    from skill_hub.infrastructure.harnesses.subagents import parse_agent

    document = parse_agent((checkout / ".claude/agents/reviewer.md").read_text())
    assert document["frontmatter"]["tier"] == "careful"


def test_advanced_agent_metadata_rejects_literal_credentials():
    from skill_hub.domain.loadout.loadout_native_codec import validate_payload

    payload = {
        "version": 1, "frontmatter": {"name": "reviewer", "env": {"API_KEY": "private-value"}}, "body": "Review.",
    }
    with pytest.raises(ProfileError) as error:
        validate_payload("agents", payload)
    assert error.value.code == "native_secret"
    assert "private-value" not in str(error.value)
    payload["frontmatter"]["env"]["API_KEY"] = "${REVIEW_API_KEY}"
    assert validate_payload("agents", payload) == payload
