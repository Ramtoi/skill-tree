"""Controller confirmations must come from the selected authenticated receiver."""

import copy
import json
from types import SimpleNamespace

import pytest

from skill_hub.application.loadout.loadout_control import confirm, request
from skill_hub.domain.loadout.loadout_profiles import ProfileError, ReceiverProfiles
from skill_hub.infrastructure.remotes.remotes import RemoteTarget


def test_confirm_uses_pinned_request_and_matches_receiver_receipt(tmp_path):
    from skill_hub.infrastructure.registry.loadout_bindings import source_fingerprint

    project = tmp_path / "source"
    project.mkdir()
    destination = tmp_path / "destination"
    destination.mkdir()
    cfg = {"path": str(project)}
    registry = {"projects": {"source": cfg}}
    binding = {
        "source_project": "source",
        "source_fingerprint": source_fingerprint(cfg),
        "mode": "manual",
        "destination_key": "app",
        "harnesses": ["codex"],
    }
    profiles = ReceiverProfiles(tmp_path / "receiver")
    profiles.initialize("box-a")
    target = RemoteTarget.from_dict(
        "box-a",
        {"connector": "headless-loadouts", "transport": {"ssh_host": "example-box"}, "host_key_sha256": "SHA256:test"},
    )
    calls = []

    class Connection:
        def command(self, argv, *, input, allow_failure):
            assert allow_failure is True
            calls.append(argv)
            body = json.loads(input)
            receipt = profiles.confirm("main", body, destination, installed={"codex"})
            return SimpleNamespace(
                returncode=0, stdout=json.dumps({"ok": True, "result": {"confirmation": receipt}, "error": None})
            )

    receipt = confirm(target, "main", binding, str(destination), registry, transport=Connection())
    assert receipt["receiver_id"] == "box-a"
    assert calls[0] == [
        "hub",
        "receive",
        "confirm",
        "--binding",
        "main",
        "--checkout",
        str(destination),
        "--proposal-stdin",
        "--json",
    ]
    assert profiles.checkout("main", binding, receipt) == destination.resolve()
    changed = copy.deepcopy(registry)
    changed["projects"]["source"]["path"] = str(destination)
    with pytest.raises(ProfileError) as error:
        confirm(target, "main", binding, str(destination), changed, transport=Connection())
    assert error.value.code == "source_review_required"
    assert len(calls) == 1


def test_request_refuses_unpinned_target_before_transport(tmp_path):
    target = RemoteTarget.from_dict("box-a", {"transport": {"ssh_host": "box-a"}})
    with pytest.raises(ProfileError, match="host key"):
        request(target, ["inspect"], transport=object())


@pytest.mark.parametrize(
    "output", ["{}", '{"ok":true,"ok":true,"result":{}}', "[]", '{"ok":true,"result":null}', '{"ok":0,"result":{}}']
)
def test_invalid_receiver_response_cannot_confirm(output):
    target = RemoteTarget.from_dict("box-a", {"transport": {"ssh_host": "box-a"}, "host_key_sha256": "SHA256:test"})
    transport = SimpleNamespace(command=lambda *a, **k: SimpleNamespace(returncode=0, stdout=output))
    with pytest.raises(ProfileError) as error:
        request(target, ["inspect"], transport=transport)
    assert error.value.code == "receiver_protocol_invalid"


def test_ssh_command_quotes_each_argument_and_sends_json_on_stdin(tmp_path):
    import shlex

    from skill_hub.infrastructure.connectors.transport.ssh import RunResult, SshTransport

    calls = []

    def run(argv, *, input=None):
        calls.append((argv, input))
        return RunResult(0, "{}", "")

    transport = SshTransport("box-a", host_key_sha256="SHA256:test", runner=run, known_hosts=tmp_path / "known_hosts")
    transport._verified = True
    argv = ["/home/me/my tools/hub", "receive", "confirm", "--checkout", "/tmp/$(touch nope); x"]
    transport.command(argv, input=b'{"mode":"manual"}')
    assert shlex.split(calls[0][0][-1]) == argv
    assert calls[0][1] == b'{"mode":"manual"}'
    assert "StrictHostKeyChecking=yes" in calls[0][0]


def test_nonzero_structured_error_is_reported_without_remote_message():
    target = RemoteTarget.from_dict("box-a", {"transport": {"ssh_host": "box-a"}, "host_key_sha256": "SHA256:test"})
    transport = SimpleNamespace(
        command=lambda *a, **k: SimpleNamespace(
            returncode=1, stdout=json.dumps({"ok": False, "error": {"code": "checkout_missing", "message": "secret"}})
        )
    )
    with pytest.raises(ProfileError) as error:
        request(target, ["confirm"], transport=transport)
    assert error.value.code == "checkout_missing" and "secret" not in str(error.value)


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_receiver_runner_enforces_limits_during_output(stream):
    import sys

    from skill_hub.application.loadout.loadout_control import bounded_runner

    with pytest.raises(ProfileError) as error:
        bounded_runner([sys.executable, "-c", f'import sys; sys.{stream}.write("x" * 2000000)'], limit=1024)
    assert error.value.code == "receiver_protocol_invalid"


def test_receiver_runner_bounds_time_and_accepts_stdin():
    import sys

    from skill_hub.application.loadout.loadout_control import bounded_runner

    reply = bounded_runner([sys.executable, "-c", "import sys; print(sys.stdin.read())"], input=b"fixture")
    assert reply.returncode == 0 and reply.stdout == "fixture\n"
    with pytest.raises(ProfileError) as error:
        bounded_runner([sys.executable, "-c", "import time; time.sleep(2)"], timeout=0.05)
    assert error.value.code == "receiver_unavailable"


def test_receiver_feed_error_is_actionable_and_redacted():
    target = RemoteTarget.from_dict("box-a", {"transport": {"ssh_host": "box-a"}, "host_key_sha256": "SHA256:test"})
    reply = {"ok": False, "error": {"code": "feed_host_key_untrusted", "message": "SECRET"}}
    transport = SimpleNamespace(command=lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps(reply)))
    with pytest.raises(ProfileError) as caught:
        request(target, ["configure"], transport=transport)
    assert "On the receiver" in str(caught.value)
    assert "Git host key" in str(caught.value)
    assert "SECRET" not in str(caught.value)
