"""Authenticated control of receiver profiles, with no connector-specific state."""

from __future__ import annotations

import re
import uuid
from pathlib import PurePosixPath
from typing import BinaryIO, Optional, cast

from skill_hub.domain.loadout.loadout_profiles import ProfileError, binding_digest, canonical, strict_json
from skill_hub.infrastructure.connectors.transport.ssh import RunResult, SshTransport
from skill_hub.infrastructure.registry.loadout_bindings import inspect_source, source_fingerprint


def bounded_runner(argv, *, input=None, limit=1024 * 1024, timeout=120) -> RunResult:
    """Bound both streams while SSH runs, including a stalled stdin consumer."""
    import os
    import selectors
    import subprocess
    import time

    process = subprocess.Popen(list(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    selector = selectors.DefaultSelector()
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    pending = memoryview(input or b"")
    deadline = time.monotonic() + timeout
    try:
        for name in streams:
            pipe = getattr(process, name)
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        if pending:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProfileError("receiver_unavailable", "The receiver operation timed out.")
            for event, _ in selector.select(min(remaining, 1)):
                pipe, name = cast(BinaryIO, event.fileobj), event.data
                if name == "stdin":
                    try:
                        sent = os.write(pipe.fileno(), pending[:65536])
                        pending = pending[sent:]
                    except BrokenPipeError:
                        pending = memoryview(b"")
                    if not pending:
                        selector.unregister(pipe)
                        pipe.close()
                else:
                    data = os.read(pipe.fileno(), 65536)
                    if not data:
                        selector.unregister(pipe)
                        pipe.close()
                    elif len(streams[name]) + len(data) > limit:
                        raise ProfileError("receiver_protocol_invalid", "Receiver output exceeded its limit.")
                    else:
                        streams[name].extend(data)
        try:
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ProfileError("receiver_unavailable", "The receiver operation timed out.") from None
        return RunResult(
            process.returncode,
            streams["stdout"].decode("utf-8", "replace"),
            streams["stderr"].decode("utf-8", "replace"),
        )
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        for name in ("stdin", "stdout", "stderr"):
            getattr(process, name).close()


def request(target, args: list[str], *, payload: Optional[dict] = None, transport=None) -> dict:
    """Only pinned SSH responses can create controller confirmation records."""
    host = target.ssh_host
    if not isinstance(host, str) or not host or host.startswith("-") or any(ord(c) < 32 for c in host):
        raise ProfileError("receiver_connection_required", "Configure the receiver SSH connection first.")
    if not target.host_key_sha256:
        raise ProfileError("receiver_connection_required", "Confirm the SSH host key before connecting.")
    executable = target.transport.get("receiver_command", "hub")
    if (
        not isinstance(executable, str)
        or not executable
        or (executable != "hub" and not PurePosixPath(executable).is_absolute())
        or any(ord(c) < 32 for c in executable)
    ):
        raise ProfileError("receiver_command_invalid", "Receiver command must be hub or an absolute executable path.")
    connection = transport or SshTransport(host, host_key_sha256=target.host_key_sha256, runner=bounded_runner)
    result = connection.command(
        [executable, "receive", *args, "--json"],
        input=canonical(payload) if payload is not None else None,
        allow_failure=True,
    )
    if result.returncode == 127:
        raise ProfileError("receiver_not_installed", "Install the receiver before using this operation.")
    if result.returncode not in (0, 1):
        raise ProfileError("receiver_unavailable", "The receiver command could not run.")
    try:
        if len(result.stdout.encode()) > 1024 * 1024:
            raise ValueError()
        reply = strict_json(result.stdout.encode())
        if (
            not isinstance(reply, dict)
            or type(reply.get("ok")) is not bool
            or not isinstance(reply.get("result") if reply["ok"] else reply.get("error"), dict)
        ):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise ProfileError("receiver_protocol_invalid", "The receiver returned an invalid response.") from None
    if not reply["ok"]:
        # Do not echo arbitrary remote errors into registry or audit state.
        code = reply["error"].get("code")
        if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
            code = "receiver_error"
        from skill_hub.infrastructure.loadout.loadout_feed import FEED_ERRORS

        message = FEED_ERRORS.get(code)
        raise ProfileError(
            code,
            "On the receiver: " + message
            if message
            else "The receiver could not complete this operation. Inspect it before retrying.",
        )
    if result.returncode != 0:
        raise ProfileError("receiver_protocol_invalid", "The receiver returned an inconsistent response.")
    return reply["result"]


def validate_source(registry: dict, binding: dict) -> None:
    project = (registry.get("projects") or {}).get(binding.get("source_project"))
    if not isinstance(project, dict) or binding.get("review_required"):
        raise ProfileError("source_review_required", "Review this source project before confirming its destination.")
    if binding.get("source_fingerprint") != source_fingerprint(project):
        raise ProfileError("source_review_required", "The source project changed; acknowledge its mapping again.")
    if binding.get("mode") == "repository":
        from skill_hub.infrastructure.registry import project_repository

        expected = project_repository.validate_repository_association(binding.get("source_repository"))
        # Projects without persisted metadata must use the remote explicitly
        # selected when the binding was created. Stored metadata retains its
        # existing validation semantics through inspect_source.
        actual = inspect_source(
            project,
            remote=expected.remote if project.get("repository") is None else None,
        )
        if not project_repository.same_repository(expected, actual):
            raise ProfileError(
                "source_repository_mismatch",
                "The source checkout no longer matches its confirmed repository.",
            )


def confirm(target, binding_id: str, binding: dict, checkout: str, registry: dict, *, transport=None) -> dict:
    validate_source(registry, binding)
    digest = binding_digest(binding_id, binding)
    result = request(
        target,
        ["confirm", "--binding", binding_id, "--checkout", checkout, "--proposal-stdin"],
        payload=binding,
        transport=transport,
    )
    receipt = result.get("confirmation")
    try:
        if (
            not isinstance(receipt, dict)
            or set(receipt) != {"receiver_id", "installation_id", "profile_revision", "binding_digest", "observed_at"}
            or receipt["receiver_id"] != target.id
            or receipt["binding_digest"] != digest
            or type(receipt["profile_revision"]) is not int
            or receipt["profile_revision"] < 1
            or not isinstance(receipt["observed_at"], str)
            or len(receipt["observed_at"]) > 64
        ):
            raise ValueError()
        uuid.UUID(receipt["installation_id"])
    except (ValueError, TypeError, AttributeError):
        raise ProfileError("receiver_confirmation_invalid", "The receiver did not confirm this binding.") from None
    return receipt
