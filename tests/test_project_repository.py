import json
import subprocess
from dataclasses import asdict
from pathlib import Path

import pytest

from skill_hub.infrastructure.registry import project_repository as repository


def _git(path: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True)


def _repo(path: Path) -> None:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", str(path)], check=True, capture_output=True, text=True)
    _git(path, "config", "user.email", "test@example.invalid")
    _git(path, "config", "user.name", "Repository Test")
    (path / "README.md").write_text("fixture\n")
    _git(path, "add", "README.md")
    _git(path, "commit", "-m", "fixture")


def test_normalize_known_github_ssh_https_forms_and_meaningful_ports():
    https = repository.normalize_repository_url("https://github.com/example-org/app.git")
    ssh = repository.normalize_repository_url("git@github.com:example-org/app.git")
    explicit_ssh = repository.normalize_repository_url("ssh://git@github.com:22/example-org/app.git")

    assert https == ssh == explicit_ssh
    assert repository.normalize_repository_url("https://forge.example:8443/Org/App.git").port == 8443
    assert repository.normalize_repository_url("https://forge.example/Org/App.git").path == "Org/App"
    assert repository.normalize_repository_url("https://forge.example/org/app") != repository.normalize_repository_url(
        "https://forge.example/Org/app"
    )


@pytest.mark.parametrize(
    "url,code",
    [
        ("https://user:secret@example.com/org/app.git", "repository_credentials_disallowed"),
        ("https://example.com/org/app.git?token=secret", "unsupported_repository_url"),
        ("git@work-alias:org/app.git", "unsupported_repository_url"),
        ("ftp://example.com/org/app.git", "unsupported_repository_url"),
        ("https://example.com/org/../app.git", "unsupported_repository_url"),
    ],
)
def test_normalize_rejects_unsafe_or_unresolved_forms_without_echoing_input(url, code):
    with pytest.raises(repository.RepositoryError) as raised:
        repository.normalize_repository_url(url)

    assert raised.value.code == code
    assert "secret" not in str(raised.value)
    assert url not in str(raised.value)


def test_normalize_rejects_scp_query_and_fragment():
    for url in ("git@forge.example:org/app.git?token=secret", "git@forge.example:org/app.git#fragment"):
        with pytest.raises(repository.RepositoryError) as raised:
            repository.normalize_repository_url(url)
        assert raised.value.code == "unsupported_repository_url"
        assert "secret" not in str(raised.value)


def test_non_github_identity_preserves_transport_user_and_path_kind():
    alice = repository.normalize_repository_url("alice@forge.example:org/app.git")
    bob = repository.normalize_repository_url("bob@forge.example:org/app.git")
    uri = repository.normalize_repository_url("ssh://alice@forge.example/org/app.git")
    https = repository.normalize_repository_url("https://forge.example/org/app.git")
    same = repository.normalize_repository_url("alice@forge.example:org/app.git")

    assert alice == same
    assert alice != bob
    assert alice != uri
    assert alice != https
    assert alice.user == "alice"
    assert alice.path_kind == "scp"
    assert uri.path_kind == "uri"


def test_global_and_injected_git_config_cannot_rewrite_literal_remote(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    _repo(root)
    _git(root, "remote", "add", "origin", "https://forge.example/org/app.git")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "missing-global-config"))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "url.https://attacker.invalid/.insteadOf")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "https://forge.example/")

    inspection = repository.inspect_project_repository(root)

    assert inspection.association.url == "https://forge.example/org/app.git"


def test_validate_and_same_repository_ignore_remote_but_keep_subdirectory():
    left = repository.validate_repository_association(
        {"url": "https://github.com/example-org/app.git", "remote": "origin", "subdirectory": "app/./"}
    )
    right = repository.validate_repository_association(
        {"url": "git@github.com:example-org/app", "remote": "upstream", "subdirectory": "app"}
    )
    other = repository.validate_repository_association(
        {"url": "git@github.com:example-org/app", "remote": "origin", "subdirectory": "."}
    )

    assert left.subdirectory == "app"
    assert repository.same_repository(left, right)
    assert not repository.same_repository(left, other)


def test_inspect_preserves_monorepo_subdirectory_and_detects_linked_worktree(tmp_path):
    root = tmp_path / "repo"
    _repo(root)
    _git(root, "remote", "add", "origin", "https://github.com/example-org/app.git")
    project = root / "packages" / "editor"
    project.mkdir(parents=True)

    inspection = repository.inspect_project_repository(project)

    assert inspection.project_path == str(project.resolve())
    assert inspection.git_root == str(root.resolve())
    assert inspection.association.subdirectory == "packages/editor"
    assert inspection.is_worktree is False

    worktree = tmp_path / "linked"
    subprocess.run(
        ["git", "-C", str(root), "worktree", "add", str(worktree)],
        check=True,
        capture_output=True,
        text=True,
    )
    linked = repository.inspect_project_repository(worktree)
    assert linked.is_worktree is True
    assert linked.git_root == str(worktree.resolve())


def test_inspect_ignores_git_environment_overrides(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    _repo(root)
    _git(root, "remote", "add", "origin", "git@github.com:example-org/app.git")
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "wrong.git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(tmp_path / "wrong-worktree"))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "remote.origin.url")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "https://attacker.invalid/wrong.git")

    inspection = repository.inspect_project_repository(root)

    assert inspection.association.url == "git@github.com:example-org/app.git"


def test_discover_is_bounded_to_roots_deduplicates_and_returns_all_valid_remotes(tmp_path):
    root = tmp_path / "workspace"
    repo = root / "repo"
    _repo(repo)
    _git(repo, "remote", "add", "origin", "https://github.com/example-org/app.git")
    _git(repo, "remote", "add", "upstream", "git@github.com:example-org/app.git")
    outside = tmp_path / "outside"
    _repo(outside)
    _git(outside, "remote", "add", "origin", "https://github.com/example-org/outside.git")
    (root / "outside-link").symlink_to(outside, target_is_directory=True)

    result = repository.discover_checkouts([root, repo])

    assert [candidate.path for candidate in result.candidates] == [str(repo.resolve())]
    assert {association.remote for association in result.candidates[0].remotes} == {"origin", "upstream"}
    assert not any(candidate.path == str(outside.resolve()) for candidate in result.candidates)
    assert result.truncated is False
    assert json.dumps(asdict(result))


def test_discovery_continues_with_sibling_when_one_remote_read_fails(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    broken = root / "broken"
    healthy = root / "healthy"
    _repo(broken)
    _repo(healthy)
    _git(healthy, "remote", "add", "origin", "https://forge.example/org/healthy.git")
    original = repository._read_all_remotes

    def read_remotes(path):
        if path == broken.resolve():
            raise repository.RepositoryError("Git inspection failed", code="git_failed")
        return original(path)

    monkeypatch.setattr(repository, "_read_all_remotes", read_remotes)
    result = repository.discover_checkouts([root])

    by_path = {candidate.path: candidate for candidate in result.candidates}
    assert by_path[str(broken.resolve())].remotes == ()
    assert by_path[str(healthy.resolve())].remotes[0].url.endswith("healthy.git")
    assert any(issue.code == "git_failed" for issue in result.issues)


def test_regular_submodule_git_file_is_not_reported_as_linked_worktree(tmp_path):
    module = tmp_path / "module"
    parent = tmp_path / "parent"
    _repo(module)
    _repo(parent)
    subprocess.run(
        [
            "git",
            "-C",
            str(parent),
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            str(module),
            "vendor/module",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    _git(parent, "commit", "-am", "add submodule")

    result = repository.discover_checkouts([parent])

    submodule = next(candidate for candidate in result.candidates if candidate.path.endswith("vendor/module"))
    assert submodule.is_worktree is False


def test_discovery_reports_invalid_root_and_inspection_reports_missing_remote(tmp_path):
    root = tmp_path / "repo"
    _repo(root)
    result = repository.discover_checkouts([tmp_path / "missing"])

    assert result.candidates == ()
    assert result.issues[0].code == "invalid_root"
    with pytest.raises(repository.RepositoryError) as raised:
        repository.inspect_project_repository(root)
    assert raised.value.code == "remote_not_found"


def test_discovery_defaults_to_home_and_skips_heavy_cache_trees(tmp_path, monkeypatch):
    repo = tmp_path / "projects" / "app"
    _repo(repo)
    _git(repo, "remote", "add", "origin", "https://github.com/example-org/app.git")
    hidden = tmp_path / "Library" / "Caches" / "unrelated"
    _repo(hidden)
    _git(hidden, "remote", "add", "origin", "https://github.com/example-org/cache.git")
    monkeypatch.setattr(repository.Path, "home", classmethod(lambda cls: tmp_path))

    result = repository.discover_checkouts()

    assert [candidate.path for candidate in result.candidates] == [str(repo.resolve())]


@pytest.mark.parametrize("workspace", ["work", "src", "custom-volume"])
def test_bounded_home_scan_finds_shallow_checkout_before_deep_unrelated_tree(tmp_path, monkeypatch, workspace):
    nested = tmp_path / "a-large-directory"
    for _ in range(12):
        nested = nested / "nested"
    nested.mkdir(parents=True)
    project = tmp_path / workspace / "app"
    _repo(project)
    _git(project, "remote", "add", "origin", "https://github.com/example-org/app.git")
    monkeypatch.setattr(repository.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(repository, "_MAX_VISITED_DIRECTORIES", 8)
    result = repository.discover_checkouts()
    assert str(project.resolve()) in {candidate.path for candidate in result.candidates}
    assert result.truncated


def test_source_remote_with_multiple_urls_produces_one_binding_association(tmp_path):
    _repo(tmp_path / "project")
    project = tmp_path / "project"
    _git(project, "remote", "add", "origin", "https://github.com/org/repo.git")
    _git(project, "config", "--add", "remote.origin.url", "git@github.com:org/repo.git")
    associations = repository.inspect_project_remotes(project)
    assert len(associations) == 1
    assert associations[0].remote == "origin"
    assert associations[0].url == "https://github.com/org/repo.git"
