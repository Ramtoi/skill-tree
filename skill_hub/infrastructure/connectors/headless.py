"""Built-in project loadout connector. Machine coordinates live in private data."""

from __future__ import annotations

from .base import DEFAULT_ALLOW, HealthResult, RemoteConnector


class HeadlessLoadoutsConnector(RemoteConnector):
    key = "headless-loadouts"
    publishable = True
    label = "Headless machine"
    description = (
        "Follow selected project loadouts in confirmed checkouts, with immediate delivery and periodic updates."
    )
    transport_kind = "ssh"
    deployment_kind = "project-loadouts"

    def capabilities(self):
        # Project delivery has a separate protocol. It never equips a second flat
        # list of skills or imports receiver changes into the controller registry.
        return set()

    def health_check(self, target):
        from skill_hub.application.loadout.loadout_control import request

        from .transport.ssh import classify_probe_exception

        try:
            result = request(target, ["inspect"])
            ready = result.get("protocol") == 1 and result.get("profile", {}).get("receiver_id") == target.id
            return HealthResult(
                reachable=True,
                authenticated=True,
                host_key_match=True,
                ready=ready,
                detail="Receiver ready" if ready else "Receiver setup is incomplete",
                detail_kind="ready" if ready else "setup_required",
            )
        except Exception as exc:
            status = classify_probe_exception(exc)
            return HealthResult(
                reachable=status.reachable,
                authenticated=status.authenticated,
                host_key_match=status.host_key_match,
                detail="Receiver unavailable; inspect machine setup.",
                detail_kind=status.detail_kind,
            )

    def sync_deployment(self, target, registry):
        from skill_hub.application.loadout.loadout_publish import publish

        return publish(registry, target)

    @staticmethod
    def _project_operation():
        from skill_hub.domain.loadout.loadout_profiles import ProfileError

        raise ProfileError("project_loadout_operation", "Manage this machine through its project checkout bindings.")

    def list_remote_artifacts(self, target, kind):
        return self._project_operation()

    def fetch_artifact(self, target, ref):
        return self._project_operation()

    def plan(self, target, desired):
        return self._project_operation()

    def apply(self, target, plan, *, allow=DEFAULT_ALLOW, force_names=frozenset()):
        return self._project_operation()

    def pull_artifact(self, target, ref):
        return self._project_operation()
