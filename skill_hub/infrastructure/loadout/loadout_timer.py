"""Optional systemd user timer for the headless receiver. No sudo or daemon dependency on Mac."""

from __future__ import annotations

import subprocess
from pathlib import Path

from skill_hub.domain.loadout.loadout_profiles import ProfileError, atomic_json, strict_json

MARKER = "# Managed by Skill Tree receiver\n"
SERVICE = "skill-tree-loadouts.service"
TIMER = "skill-tree-loadouts.timer"


def _run(*args: str):
    try:
        return subprocess.run(
            ["systemctl", "--user", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ProfileError("timer_unavailable", "A systemd user session is required for periodic delivery.") from None


def status() -> dict:
    enabled = _run("is-enabled", TIMER)
    active = _run("is-active", TIMER)
    return {"enabled": enabled.returncode == 0, "active": active.returncode == 0}


def install(home: Path, executable: Path, interval: int) -> dict:
    import os
    import tempfile

    if type(interval) is not int or not 30 <= interval <= 3600:
        raise ProfileError("invalid_timer_interval", "Polling interval must be between 30 and 3600 seconds.")
    if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
        raise ProfileError("receiver_not_installed", "Install the receiver launcher before starting its timer.")
    receiver_root = home / ".local" / "share" / "skill-tree" / "receiver"
    if home.is_symlink() or executable.is_symlink() or executable != receiver_root / "bin" / "hub":
        raise ProfileError("receiver_not_installed", "Use the verified managed receiver launcher.")
    import hashlib

    try:
        installation = strict_json((receiver_root / "installation.json").read_bytes())
        if (
            installation["command"] != str(executable)
            or installation["launcher_sha256"] != hashlib.sha256(executable.read_bytes()).hexdigest()
        ):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise ProfileError(
            "receiver_not_installed", "Repair the receiver launcher before installing its timer."
        ) from None
    # Systemd expands percent specifiers even within quoted arguments.
    command = str(executable).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    if any(ord(c) < 32 for c in command):
        raise ProfileError("invalid_receiver_command", "The receiver launcher path is invalid.")
    unit_root = home / ".config" / "systemd" / "user"
    for path in (unit_root, *unit_root.parents):
        if path == home:
            break
        if path.is_symlink():
            raise ProfileError("timer_conflict", "The user timer directory traverses a symlink.")
    units = {
        SERVICE: MARKER
        + "[Unit]\nDescription=Skill Tree loadout receiver\n\n[Service]\nType=oneshot\n"
        + f'ExecStart="{command}" receive once --json\nTimeoutStartSec=120\n',
        TIMER: MARKER
        + "[Unit]\nDescription=Check for Skill Tree loadout updates\n\n[Timer]\n"
        + f"OnBootSec=30s\nOnUnitActiveSec={interval}s\nRandomizedDelaySec=5s\n"
        + f"Unit={SERVICE}\n\n[Install]\nWantedBy=timers.target\n",
    }
    for name in units:
        path = unit_root / name
        if path.is_symlink() or (path.exists() and not path.read_text().startswith(MARKER)):
            raise ProfileError("timer_conflict", "A user-authored timer or service already uses this name.")
    # Test the user manager before materializing units.
    if _run("show-environment").returncode:
        raise ProfileError("timer_unavailable", "Start a systemd user session before enabling periodic delivery.")
    unit_root.mkdir(parents=True, exist_ok=True)
    for name, content in units.items():
        fd, temporary = tempfile.mkstemp(prefix=".skill-tree-", dir=unit_root)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, unit_root / name)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
    failed = _run("daemon-reload").returncode or _run("enable", "--now", TIMER).returncode
    result = status()
    partial = bool(failed or not result["enabled"] or not result["active"])
    result.update(
        interval_seconds=interval,
        configured=True,
        partial=partial,
        error="Timer files are installed; retry activation of the user timer." if partial else None,
    )
    atomic_json(receiver_root / "timer.json", result)
    return result
