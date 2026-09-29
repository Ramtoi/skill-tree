"""One broken target must not interrupt the remaining remote sync pass."""

from types import SimpleNamespace

import pytest

from skill_hub.application.sync import remote_dispatch


@pytest.mark.parametrize("broken", [42, {"connector": "bad", "transport": 42}, {"connector": "bad"}])
def test_bad_target_isolated_through_parse_plugin_and_projection(tmp_data_home, monkeypatch, broken):
    from skill_hub.infrastructure import connectors

    applied = []

    class Connector:
        def health_check(self, target):
            return SimpleNamespace(ok=True)

        def plan(self, target, desired):
            return SimpleNamespace(actions=[])

        def apply(self, target, plan):
            applied.append(target.id)
            return SimpleNamespace(created=[], fast_forwarded=[], removed=[], errors=[])

    def desired(config, registry):
        if config["connector"] == "bad":
            raise ValueError("projection failed")
        return object()

    monkeypatch.setattr(connectors, "get_connector", lambda key: Connector())
    monkeypatch.setattr(remote_dispatch, "build_remote_desired_state", desired)
    report = {"global": {"remotes": {}}}
    remote_dispatch._run_remote_dispatch({"remotes": {"broken": broken, "working": {"connector": "ok"}}},
                                         set(), report=report)
    assert applied == ["working"]
    assert report["global"]["remotes"]["targets"]["broken"]["state"] == "failed"


def test_missing_plugin_and_empty_configuration_do_not_fail_sync(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure import connectors

    calls = []

    def missing(key):
        calls.append(key)
        raise RuntimeError("optional plugin dependency missing")

    monkeypatch.setattr(connectors, "get_connector", missing)
    remote_dispatch._run_remote_dispatch({}, set())
    assert calls == []
    remote_dispatch._run_remote_dispatch({"remotes": {"absent": {"connector": "missing"}}}, set())
    assert calls == ["missing"]
