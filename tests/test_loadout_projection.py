"""Selected provider payloads are portable, explicit and read-only to compile."""

import json

import pytest

from skill_hub.domain.loadout.loadout_native_codec import capture_loadout_codec_context
from skill_hub.domain.loadout.loadout_profiles import ProfileError, ReceiverProfiles
from skill_hub.domain.loadout.loadout_projection import compile_projection
from skill_hub.infrastructure.registry.loadout_bindings import proposed_binding
from skill_hub.infrastructure.remotes.remotes import RemoteTarget


def _context():
    return capture_loadout_codec_context()


@pytest.fixture
def setup(tmp_data_home):
    source = tmp_data_home / "skills" / "example"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example skill\n---\nBody\n")
    project = tmp_data_home / "project"
    project.mkdir()
    destination = tmp_data_home / "destination"
    destination.mkdir()
    registry = {
        "skills": {"example": {"source": str(source), "type": "claude-skill", "scope": "portable"}},
        "bundles": {},
        "projects": {"app": {"path": str(project), "enabled": ["example"]}},
    }
    binding = proposed_binding(registry, project="app", destination_key="app", harnesses=["codex"], manual=True)
    profile = ReceiverProfiles(tmp_data_home / "receiver")
    profile.initialize("box-a")
    binding["confirmation"] = profile.confirm("main", binding, destination, installed={"codex"})
    target = RemoteTarget.from_dict("box-a", {"connector": "headless-loadouts", "project_bindings": {"main": binding}})
    return registry, target, source


def test_projection_has_only_selected_portable_files_and_no_controller_paths(setup, tmp_data_home):
    registry, target, source = setup
    before = {str(p): p.read_bytes() for p in tmp_data_home.rglob("*") if p.is_file()}
    projection, assets = compile_projection(
        registry, target, feed_id="a" * 32, generation=1, previous=None, codec_context=_context()
    )
    assert str(tmp_data_home) not in json.dumps(projection)
    files = projection["bindings"]["main"]["files"]
    assert {f["harness"] for f in files} == {"codex"}
    assert next(assets[f["asset"]] for f in files if f["path"] == "SKILL.md") == (source / "SKILL.md").read_bytes()
    assert {str(p): p.read_bytes() for p in tmp_data_home.rglob("*") if p.is_file()} == before


def test_missing_source_and_unsupported_companion_never_publish_empty_success(setup):
    registry, target, source = setup
    registry["skills"]["example"]["ships_with"] = {"agents": ["reviewer"]}
    with pytest.raises(ProfileError) as error:
        compile_projection(registry, target, feed_id="a" * 32, generation=1, previous=None, codec_context=_context())
    assert error.value.code == "unsupported_loadout_requirement"
    registry["skills"]["example"].pop("ships_with")
    (source / "SKILL.md").unlink()
    with pytest.raises(ProfileError) as error:
        compile_projection(registry, target, feed_id="a" * 32, generation=1, previous=None, codec_context=_context())
    assert error.value.code == "source_missing"


def test_source_symlink_is_not_copied_or_silently_dropped(setup, tmp_data_home):
    registry, target, source = setup
    secret = tmp_data_home / "secret"
    secret.write_text("must stay local")
    (source / "reference").symlink_to(secret)
    with pytest.raises(ProfileError) as error:
        compile_projection(registry, target, feed_id="a" * 32, generation=1, previous=None, codec_context=_context())
    assert error.value.code == "unsupported_source"


@pytest.mark.parametrize("renamed", [False, True])
@pytest.mark.parametrize("provider", ["codex", "claude-code", "pi", "opencode"])
@pytest.mark.parametrize("mode", ["auto", "user-only", "model-only", "conflicted"])
@pytest.mark.parametrize("source_policy", [None, b"# keep\npolicy: {allow_implicit_invocation: false}\n"])
def test_remote_and_local_cli_render_the_same_invocation(setup, tmp_data_home, provider, mode, source_policy, renamed):
    from skill_hub.application.skills.skill_variants import _ensure_combined_variant

    registry, _, source = setup
    registry["skills"]["example"]["invocation"] = mode
    if renamed:
        registry["skills"]["example"]["managed"] = "external"
        (source / "SKILL.md").write_text((source / "SKILL.md").read_text().replace("name: example", "name: upstream"))
    if source_policy is not None:
        (source / "agents").mkdir()
        (source / "agents/openai.yaml").write_bytes(source_policy)
    binding = proposed_binding(registry, project="app", destination_key="app", harnesses=[provider], manual=True)
    profiles = ReceiverProfiles(tmp_data_home / "receiver")
    binding["confirmation"] = profiles.confirm("main", binding, tmp_data_home / "destination", installed={provider})
    target = RemoteTarget.from_dict("box-a", {"connector": "headless-loadouts", "project_bindings": {"main": binding}})
    before = {str(p): p.read_bytes() for p in source.rglob("*") if p.is_file()}
    from skill_hub.domain.skills.skill_meta import RENAME_VARIANT_MODE, skill_rename_patch

    rename_patch = skill_rename_patch("example", registry["skills"]["example"])
    local, _, local_outcomes = _ensure_combined_variant(
        "example", source, RENAME_VARIANT_MODE if renamed and mode == "auto" else mode,
        renamed=rename_patch, native_harnesses={provider}, native_mode=mode,
    )
    remote_outcomes = []
    projection, assets = compile_projection(
        registry, target, feed_id="a" * 32, generation=1, previous=None, invocation_outcomes=remote_outcomes,
        codec_context=_context(),
    )
    remote = {entry["path"]: assets[entry["asset"]] for entry in projection["bindings"]["main"]["files"]}
    local_policy = local / "agents/openai.yaml"
    assert remote.get("agents/openai.yaml") == (local_policy.read_bytes() if local_policy.exists() else None)
    assert remote["SKILL.md"] == (local / "SKILL.md").read_bytes()
    for key in ("support", "requested_mode", "implicit_behavior", "explicit_behavior", "limitations", "reason_code"):
        assert remote_outcomes[0][key] == local_outcomes[0][key]
    assert {str(p): p.read_bytes() for p in source.rglob("*") if p.is_file()} == before


@pytest.mark.parametrize('metadata_directory', [True, False])
def test_repo_root_skill_excludes_git_metadata(setup, metadata_directory):
    registry, target, source = setup
    metadata = source / '.git'
    if metadata_directory:
        metadata.mkdir()
        (metadata / 'config').write_text('private git configuration')
    else:
        metadata.write_text('gitdir: /private/worktrees/example')
    projection, assets = compile_projection(
        registry, target, feed_id='a' * 32, generation=1, previous=None, codec_context=_context()
    )
    assert all('.git' not in row['path'].split('/') for row in projection['bindings']['main']['files'])
    assert not any(b'private' in value for value in assets.values())


def test_shared_reference_in_registered_skill_is_materialized(setup, tmp_data_home):
    registry, target, source = setup
    shared = tmp_data_home / 'skills' / 'review'
    shared.mkdir()
    (shared / 'criteria.md').write_text('shared criteria')
    registry['skills']['review'] = {'source': str(shared), 'type': 'claude-skill'}
    (source / 'references').mkdir()
    (source / 'references/criteria.md').symlink_to('../../review/criteria.md')
    projection, assets = compile_projection(
        registry, target, feed_id='a' * 32, generation=1, previous=None, codec_context=_context()
    )
    row = next(row for row in projection['bindings']['main']['files'] if row['path']=='references/criteria.md')
    assert assets[row['asset']] == b'shared criteria'
    assert (source / 'references/criteria.md').is_symlink()


@pytest.mark.parametrize('kind', ['git', 'directory', 'broken', 'fifo'])
def test_shared_links_keep_source_boundaries(setup, kind):
    import os
    registry, target, source = setup
    if kind == 'git':
        (source / '.git').mkdir()
        (source / '.git/config').write_text('private configuration')
        (source / 'reference').symlink_to('.git/config')
    elif kind == 'directory':
        (source / 'folder').mkdir()
        (source / 'reference').symlink_to('folder')
    elif kind == 'broken':
        (source / 'reference').symlink_to('missing')
    else:
        os.mkfifo(source / 'reference')
    with pytest.raises(ProfileError) as error:
        compile_projection(registry, target, feed_id='a' * 32, generation=1, previous=None, codec_context=_context())
    assert error.value.code == 'unsupported_source'
