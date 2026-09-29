"""User-scoped Linux receiver installation from the controller's shipped code.

The same standard-library-only file is the authenticated SSH bootstrap program.
It accepts a bounded archive whose digest is supplied by the controller, never
an installer or executable from the loadout feed.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

MAX_PACKAGE = 64 * 1024 * 1024

ROOT_MODULES = frozenset(
    {
        "hub",
        "skill_hub_mcp_server",
    }
)

PACKAGE_DIRECTORIES = ("skill_hub", "connectors", "hooks", "vendor")


def package_receiver(code: Path) -> tuple[bytes, str]:
    files = [code / (name + ".py") for name in sorted(ROOT_MODULES)]
    files += [code / "VERSION", code / "requirements.txt", code / "ccusage-pricing.json"]
    for directory in PACKAGE_DIRECTORIES:
        root = code / directory
        if not root.is_dir():
            raise ValueError("The shipped receiver dependencies are incomplete; repair the Skill Tree installation.")
        files.extend(
            path
            for path in root.rglob("*")
            if path.is_file()
            and not path.is_symlink()
            and "__pycache__" not in path.parts
            and path.suffix not in {".pyc", ".so", ".dylib"}
        )
    buffer = io.BytesIO()
    total = 0
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for path in sorted(files):
            relative = path.relative_to(code).as_posix()
            content = path.read_bytes()
            total += len(content)
            if total > MAX_PACKAGE or len(files) > 10000:
                raise ValueError("Receiver code exceeds the installation package limit.")
            item = tarfile.TarInfo(relative)
            item.size = len(content)
            item.mode = 0o644
            item.mtime = 0
            archive.addfile(item, io.BytesIO(content))
    payload = gzip.compress(buffer.getvalue(), mtime=0)
    if len(payload) > MAX_PACKAGE:
        raise ValueError("Receiver archive exceeds the installation package limit.")
    return payload, hashlib.sha256(payload).hexdigest()


def _private_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("Receiver installation cannot traverse symlink directories.")
    if not path.exists():
        _private_directory(path.parent)
        path.mkdir(mode=0o700)
    elif not path.is_dir():
        raise ValueError("Receiver installation path is not a directory.")


def install_payload(payload: bytes, digest: str, *, home: Path, system: str) -> dict:
    if system != "Linux" or sys.version_info < (3, 9):
        raise ValueError("The receiver requires Linux and Python 3.9 or newer.")
    if (
        not re.fullmatch(r"[a-f0-9]{64}", digest)
        or len(payload) > MAX_PACKAGE
        or hashlib.sha256(payload).hexdigest() != digest
    ):
        raise ValueError("The receiver installation package digest does not match.")
    if home.is_symlink():
        raise ValueError("Receiver installation requires a home directory without a symlink.")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        members = archive.getmembers()
        total = 0
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (
                not member.isfile()
                or path.is_absolute()
                or str(path) != member.name
                or any(p in {"", ".", ".."} for p in member.name.split("/"))
                or "\\" in member.name
                or member.name in names
                or member.size < 0
            ):
                raise ValueError("Receiver package contains an unsafe archive entry.")
            top = path.parts[0]
            allowed = (
                len(path.parts) == 1
                and (
                    member.name in {"VERSION", "requirements.txt", "ccusage-pricing.json"}
                    or member.name.endswith(".py")
                    and member.name[:-3] in ROOT_MODULES
                )
            ) or (len(path.parts) > 1 and top in PACKAGE_DIRECTORIES)
            if not allowed:
                raise ValueError("Receiver package contains a path outside the shipped code allowlist.")
            names.add(member.name)
            total += member.size
            if total > MAX_PACKAGE or len(names) > 10000:
                raise ValueError("Receiver package exceeds the extraction limit.")
        required = {
            "hub.py",
            "skill_hub/entrypoints/cli/receive.py",
            "skill_hub/domain/loadout/loadout_profiles.py",
            "vendor/yaml/__init__.py",
        }
        if not required.issubset(names):
            raise ValueError("Receiver package is incomplete.")
        root = home.resolve() / ".local" / "share" / "skill-tree" / "receiver"
        for ancestor in (root, *root.parents):
            if ancestor == home.resolve():
                break
            if ancestor.is_symlink():
                raise ValueError("Receiver installation cannot traverse symlink directories.")
        _private_directory(root / "releases")
        release = root / "releases" / digest
        if release.is_symlink():
            raise ValueError("Receiver release path is a symlink.")
        if release.exists():
            observed = set()
            for existing in release.rglob("*"):
                if existing.is_symlink():
                    raise ValueError("The existing receiver release contains an unexpected symlink.")
                if existing.is_file():
                    observed.add(existing.relative_to(release).as_posix())
            if observed != names:
                raise ValueError("The existing receiver release has unexpected files; repair it before activation.")
            for member in members:
                existing = release / member.name
                archived = archive.extractfile(member)
                if archived is None:
                    raise ValueError("Receiver package entry is unreadable.")
                if (
                    existing.is_symlink()
                    or not existing.is_file()
                    or any(parent.is_symlink() for parent in existing.parents if parent != root.parent)
                    or existing.read_bytes() != archived.read()
                ):
                    raise ValueError("The existing receiver release was modified; repair it before activation.")
        else:
            temporary = Path(tempfile.mkdtemp(prefix=".install-", dir=root / "releases"))
            try:
                for member in members:
                    target = temporary / member.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    entry_stream = archive.extractfile(member)
                    if entry_stream is None:
                        raise ValueError("Receiver package entry is unreadable.")
                    with target.open("xb") as output:
                        shutil.copyfileobj(entry_stream, output)
                        output.flush()
                        os.fsync(output.fileno())
                    target.chmod(0o644)
                os.replace(temporary, release)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
    # Verify imports and CLI registration before changing the active launcher.
    environment = dict(
        os.environ, SKILL_HUB_HOME=str(root / "data"), SKILL_HUB_CODE=str(release), PYTHONDONTWRITEBYTECODE="1"
    )
    check = subprocess.run(
        [sys.executable, str(release / "hub.py"), "receive", "--help"],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if check.returncode:
        raise ValueError("The receiver package failed its startup check; the previous launcher was preserved.")
    _private_directory(root / "bin")
    launcher = root / "bin" / "hub"
    # Paths are shell quoted as literal strings. Machine paths exist only in the
    # receiver installation, never in the publicly shipped source.
    import shlex

    wrapper = (
        "#!/bin/sh\n# Skill Tree receiver launcher\nexport PYTHONDONTWRITEBYTECODE=1\n"
        + "export SKILL_HUB_HOME="
        + shlex.quote(str(root / "data"))
        + "\n"
        + "export SKILL_HUB_CODE="
        + shlex.quote(str(release))
        + "\n"
        + 'if [ "$1" != "receive" ]; then echo "Use hub receive on this installation" >&2; exit 2; fi\n'
        + "exec "
        + shlex.quote(sys.executable)
        + " "
        + shlex.quote(str(release / "hub.py"))
        + ' "$@"\n'
    )
    fd, temporary_name = tempfile.mkstemp(prefix=".hub-", dir=launcher.parent)
    temporary_wrapper = Path(temporary_name)
    with os.fdopen(fd, "w") as stream:
        stream.write(wrapper)
        stream.flush()
        os.fsync(stream.fileno())
    temporary_wrapper.chmod(0o700)
    os.replace(temporary_wrapper, launcher)
    installation = {
        "package_digest": digest,
        "command": str(launcher),
        "launcher_sha256": hashlib.sha256(wrapper.encode()).hexdigest(),
    }
    fd, manifest_temp = tempfile.mkstemp(prefix=".install-state-", dir=root)
    with os.fdopen(fd, "w") as stream:
        json.dump(installation, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(manifest_temp, root / "installation.json")
    return {"installed": True, "package_digest": digest, "command": str(launcher), "protocol": 1}


def install_remote(target, *, code: Path) -> dict:
    from skill_hub.application.loadout.loadout_control import bounded_runner
    from skill_hub.domain.loadout.loadout_profiles import ProfileError, strict_json
    from skill_hub.infrastructure.connectors.transport.ssh import SshTransport

    if not target.ssh_host or not target.host_key_sha256:
        raise ProfileError("receiver_connection_required", "Confirm the SSH host key before installing.")
    payload, digest = package_receiver(code)
    transport = SshTransport(target.ssh_host, host_key_sha256=target.host_key_sha256, runner=bounded_runner)
    script = Path(__file__).read_text()
    result = transport.command(["python3", "-c", script, "--install", digest], input=payload)
    reply = strict_json(result.stdout.encode())
    if (
        not isinstance(reply, dict)
        or set(reply) != {"installed", "package_digest", "command", "protocol"}
        or type(reply.get("protocol")) is not int
        or reply["protocol"] != 1
        or reply.get("package_digest") != digest
        or reply.get("installed") is not True
        or not isinstance(reply.get("command"), str)
        or not reply["command"].startswith("/")
    ):
        raise ProfileError("receiver_install_failed", "The receiver did not confirm installation.")
    return reply


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "--install":
            raise ValueError("Invalid installation request.")
        print(
            json.dumps(
                install_payload(
                    sys.stdin.buffer.read(MAX_PACKAGE + 1), sys.argv[2], home=Path.home(), system=platform.system()
                )
            )
        )
    except Exception:
        print(
            json.dumps({"installed": False, "error": "Receiver installation failed; prior activation was preserved."})
        )
        raise SystemExit(1)
