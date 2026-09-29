"""Private Git transport must verify publisher identity without executing content."""

import subprocess

import pytest

from skill_hub.domain.loadout.loadout_profiles import ProfileError
from skill_hub.infrastructure.loadout.loadout_feed import GitFeed, asset_digest


def body(*, generation=1, previous=None, data=b"skill"):
    from skill_hub.domain.loadout.loadout_profiles import binding_digest

    digest = asset_digest(data)
    proposal = {"mode": "manual", "source_fingerprint": "b" * 64, "destination_key": "app", "harnesses": ["codex"]}
    binding = {
        "proposal": proposal,
        "confirmation": {
            "receiver_id": "box-a",
            "installation_id": "11111111-1111-1111-1111-111111111111",
            "profile_revision": 1,
            "binding_digest": binding_digest("main", proposal),
            "observed_at": "2026-09-16T00:00:00+00:00",
        },
        "files": [
            {
                "scope": "project",
                "harness": "codex",
                "area": "skills",
                "name": "example",
                "path": "SKILL.md",
                "asset": digest,
                "mode": 0o644,
            }
        ],
    }
    return {
        "schema": 1,
        "feed_id": "a" * 32,
        "receiver_id": "box-a",
        "generation": generation,
        "previous": previous,
        "bindings": {"main": binding},
        "retired": {},
        "assets": {digest: len(data)},
    }, {digest: data}


@pytest.fixture
def feed(tmp_data_home):
    from skill_hub.infrastructure.connectors.signing import ensure_signing_key

    remote = tmp_data_home / "feed.git"
    subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
    key = ensure_signing_key()
    return GitFeed(tmp_data_home / "publisher", str(remote), "box-a", allow_local=True), key, remote


def test_signed_publication_and_independent_receiver_cache(feed, tmp_data_home):
    publisher, key, remote = feed
    projection, assets = body()
    revision = publisher.publish(projection, assets, parent=None)
    receiver = GitFeed(tmp_data_home / "receiver", str(remote), "box-a", allow_local=True)
    assert receiver.fetch() == revision
    observed, received = receiver.read(revision, key)
    assert observed == projection and received == assets
    second, data = body(generation=2, previous=revision, data=b"changed")
    newer = publisher.publish(second, data, parent=revision)
    assert receiver.fetch() == newer and receiver.descendant(newer, revision)
    assert not receiver.descendant(revision, newer)
    assert not (tmp_data_home / "receiver" / "projection.json").exists()


def test_second_writer_cannot_force_advance_or_overwrite(feed, tmp_data_home):
    publisher, _, remote = feed
    projection, assets = body()
    revision = publisher.publish(projection, assets, parent=None)
    other = GitFeed(tmp_data_home / "other", str(remote), "box-a", allow_local=True)
    with pytest.raises(ProfileError) as error:
        other.publish(projection, assets, parent=None)
    assert error.value.code == "feed_advanced"
    assert publisher.fetch() == revision


def test_wrong_key_and_modified_projection_are_rejected(feed, tmp_data_home):
    publisher, key, _ = feed
    projection, assets = body()
    revision = publisher.publish(projection, assets, parent=None)
    wrong = tmp_data_home / "wrong"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(wrong)], check=True)
    with pytest.raises(ProfileError) as error:
        publisher.read(revision, wrong.with_suffix(".pub").read_text())
    assert error.value.code == "feed_signature_invalid"


def test_declared_digest_and_secret_url_rejected_before_publication(feed, tmp_data_home):
    publisher, _, _ = feed
    projection, assets = body()
    projection["assets"][next(iter(assets))] = 900
    with pytest.raises(ProfileError, match="size or digest"):
        publisher.publish(projection, assets, parent=None)
    assert publisher.fetch() is None
    with pytest.raises(ValueError):
        GitFeed(tmp_data_home / "other", "https://user:secret@example.com/repo.git", "box-a")


def test_accept_requires_identity_and_monotonic_generation(feed):
    from skill_hub.domain.loadout.loadout_profiles import canonical

    publisher, key, _ = feed
    projection, assets = body()
    first = publisher.publish(projection, assets, parent=None)
    state = {
        "feed_id": projection["feed_id"],
        "generation": 1,
        "revision": first,
        "digest": asset_digest(canonical(projection)),
    }
    assert publisher.accept(first, key, "a" * 32, state)[0] == projection
    with pytest.raises(ProfileError, match="different feed"):
        publisher.accept(first, key, "b" * 32, state)
    second_body, second_assets = body(generation=2, previous=first, data=b"next")
    second = publisher.publish(second_body, second_assets, parent=first)
    assert publisher.accept(second, key, "a" * 32, state)[0] == second_body
    state.update(generation=2, revision=second, digest=asset_digest(canonical(second_body)))
    with pytest.raises(ProfileError) as error:
        publisher.accept(first, key, "a" * 32, state)
    assert error.value.code == "stale_publication"


def test_malformed_nested_wire_and_plaintext_transport_are_rejected(feed, tmp_data_home):
    from skill_hub.infrastructure.loadout.loadout_feed import validate_projection

    projection, assets = body()
    projection["bindings"]["main"] = ["not-a-binding"]
    with pytest.raises(ProfileError):
        validate_projection(projection, assets)
    with pytest.raises(ProfileError, match="SSH or HTTPS"):
        GitFeed(tmp_data_home / "cache", "http://example.com/private.git", "box-a")


@pytest.mark.parametrize(
    "message,code",
    [
        (b"Host key verification failed. SECRET", "feed_host_key_untrusted"),
        (b"Permission denied (publickey). SECRET", "feed_authentication_failed"),
        (
            b"fatal: could not read Username for 'https://github.com': terminal prompts disabled SECRET",
            "feed_authentication_failed",
        ),
    ],
)
def test_git_errors_are_actionable_without_echoing_credentials(tmp_data_home, monkeypatch, message, code):
    from types import SimpleNamespace

    def fail(argv, **kwargs):
        kwargs["stderr"].write(message)
        return SimpleNamespace(returncode=128)

    monkeypatch.setattr(subprocess, "run", fail)
    feed = GitFeed(tmp_data_home / "cache", "git@example.org:team/feed.git", "box-a")
    with pytest.raises(ProfileError) as caught:
        feed._git("ls-remote", feed.url)
    assert caught.value.code == code
    assert "SECRET" not in str(caught.value)


@pytest.mark.parametrize(
    "github_url",
    [
        "https://github.com/team/feed.git",
        "https://GitHub.com/team/feed.git",
        "https://GitHub.com:443/team/feed.git",
    ],
)
def test_github_https_uses_existing_gh_login_without_global_git_config(tmp_data_home, monkeypatch, github_url):
    from types import SimpleNamespace

    from skill_hub.infrastructure.harnesses import harness_probe

    monkeypatch.setattr(harness_probe, "resolve_binary", lambda name: "/opt/tools/gh")
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs["env"]))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", run)
    for url in [github_url, "https://example.org/team/feed.git"]:
        GitFeed(tmp_data_home / "cache", url, "box-a")._git("ls-remote", url)
    assert any("gh auth git-credential" in arg for arg in calls[0][0])
    assert not any("gh auth git-credential" in arg for arg in calls[1][0])
    assert calls[0][1]["GIT_CONFIG_GLOBAL"] == "/dev/null"
    assert GitFeed(tmp_data_home / "cache", github_url, "box-a").url == "https://github.com/team/feed.git"


def test_replace_foreign_grafts_generation_one_onto_a_foreign_head(feed, tmp_data_home):
    publisher, key, remote = feed
    foreign_body, foreign_assets = body()
    foreign_head = publisher.publish(foreign_body, foreign_assets, parent=None)

    grafted_body, grafted_assets = body(previous=foreign_head)
    grafted_body["feed_id"] = "c" * 32
    reconnect = GitFeed(tmp_data_home / "reconnect", str(remote), "box-a", allow_local=True)
    new_head = reconnect.publish(grafted_body, grafted_assets, parent=foreign_head, replace_foreign=True)

    parents = subprocess.check_output(
        ["git", "--git-dir", str(remote), "rev-list", "--parents", "-n", "1", new_head]
    ).strip().decode().split()[1:]
    assert parents == [foreign_head]
    read_back, _ = reconnect.read(new_head, key)
    assert read_back["generation"] == 1 and read_back["feed_id"] == "c" * 32


def test_replace_foreign_on_an_own_chain_head_raises_feed_integrity_error(feed):
    publisher, key, remote = feed
    first, assets = body()
    head = publisher.publish(first, assets, parent=None)
    second, second_assets = body(previous=head)
    with pytest.raises(ProfileError) as error:
        publisher.publish(second, second_assets, parent=head, replace_foreign=True)
    assert error.value.code == "feed_integrity_error"
    assert "already belongs to this controller" in str(error.value)


def test_replace_foreign_refuses_generation_two(feed):
    publisher, key, remote = feed
    first, assets = body()
    head = publisher.publish(first, assets, parent=None)
    second, second_assets = body(generation=2, previous=head)
    second["feed_id"] = "c" * 32
    with pytest.raises(ProfileError) as error:
        publisher.publish(second, second_assets, parent=head, replace_foreign=True)
    assert error.value.code == "feed_integrity_error"
    assert "generation one" in str(error.value)


def test_replace_foreign_reraises_transient_feed_unavailable_from_read(feed, monkeypatch):
    publisher, key, remote = feed
    first, assets = body()
    head = publisher.publish(first, assets, parent=None)
    second, second_assets = body(previous=head)
    second["feed_id"] = "c" * 32

    def flaky_read(self, revision, public_key):
        raise ProfileError("feed_unavailable", "Git could not access the loadout feed.")

    monkeypatch.setattr(GitFeed, "read", flaky_read)
    with pytest.raises(ProfileError) as error:
        publisher.publish(second, second_assets, parent=head, replace_foreign=True)
    assert error.value.code == "feed_unavailable"


def test_publish_without_replace_foreign_still_raises_feed_advanced_on_a_non_empty_branch(feed, tmp_data_home):
    publisher, key, remote = feed
    first, assets = body()
    publisher.publish(first, assets, parent=None)
    other = GitFeed(tmp_data_home / "other-writer", str(remote), "box-a", allow_local=True)
    second, second_assets = body(generation=1, previous=None)
    with pytest.raises(ProfileError) as error:
        other.publish(second, second_assets, parent=None)
    assert error.value.code == "feed_advanced"


def test_feed_publication_preserves_backup_branch(feed):
    publisher, key, remote = feed
    first, assets = body()
    backup_tip = publisher.publish(first, assets, parent=None)
    subprocess.run(["git", "--git-dir", str(remote), "update-ref", "refs/heads/main", backup_tip], check=True)
    second, assets = body(generation=2, previous=backup_tip, data=b"new loadout")
    revision = publisher.publish(second, assets, parent=backup_tip)
    assert publisher.read(revision, key)[0]["generation"] == 2
    assert (
        subprocess.check_output(["git", "--git-dir", str(remote), "rev-parse", "refs/heads/main"]).strip().decode()
        == backup_tip
    )
