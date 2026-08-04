"""Remote ownership sidecar — per-artifact `last_pushed_sha256` tracking.

One sidecar file per `(remote_id, surface)` at

    <data_home>/state/remote_<id>/<surface>.managed.json

storing the names Hub owns on that remote surface plus, per artifact, the
`last_pushed_sha256` that serves as the **base** for 3-way drift classification
(see `drift.classify`). This is the ownership invariant: cleanup/remove and
drift only ever consider sidecar-listed names — the remote's pre-existing
library is invisible to apply/cleanup (DECISIONS.md D9).

Mirrors `permissions.SidecarState` style (versioned JSON, atomic write, lives
under `hub.data_home()/state/`). A **missing or corrupt sidecar reads as empty**
and NEVER raises — that is what makes cleanup a safe no-op when state is lost.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

SIDECAR_VERSION = 1

# Conservative sanitization for the on-disk dir component derived from the
# remote id (registry keys are slug-like already; this is belt-and-braces so a
# weird id can never escape the state dir).
_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _state_root() -> Path:
    """`<data_home>/state/` — resolved via hub.data_home() to honour SKILL_HUB_HOME."""
    import hub  # local import to avoid an import cycle at module load

    return hub.data_home() / "state"


def _safe_id(remote_id: str) -> str:
    return _SAFE.sub("-", remote_id).strip("-") or "remote"


def sidecar_path(remote_id: str, surface: str) -> Path:
    """Path to the `(remote_id, surface)` ownership sidecar."""
    return _state_root() / f"remote_{_safe_id(remote_id)}" / f"{surface}.managed.json"


@dataclass(frozen=True)
class ArtifactRecord:
    name: str
    kind: str
    last_pushed_sha256: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "last_pushed_sha256": self.last_pushed_sha256,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ArtifactRecord":
        return cls(
            name=str(data["name"]),
            kind=str(data.get("kind", "")),
            last_pushed_sha256=str(data.get("last_pushed_sha256", "")),
        )


@dataclass
class RemoteSidecar:
    """In-memory view of one `(remote, surface)` ownership sidecar."""

    remote: str
    surface: str
    artifacts: list[ArtifactRecord] = field(default_factory=list)
    version: int = SIDECAR_VERSION
    written_at: str = ""

    # --- accessors ---------------------------------------------------------

    def base_sha(self, name: str) -> Optional[str]:
        """The recorded base sha for `name`, or None if not managed."""
        for a in self.artifacts:
            if a.name == name:
                return a.last_pushed_sha256
        return None

    def managed_names(self) -> set[str]:
        return {a.name for a in self.artifacts}

    def is_managed(self, name: str) -> bool:
        return any(a.name == name for a in self.artifacts)

    # --- mutators (in-memory; call write() to persist) ---------------------

    def record(self, name: str, kind: str, sha256: str) -> None:
        """Insert or update the base sha for `name`."""
        for i, a in enumerate(self.artifacts):
            if a.name == name:
                self.artifacts[i] = ArtifactRecord(name, kind or a.kind, sha256)
                return
        self.artifacts.append(ArtifactRecord(name, kind, sha256))

    def forget(self, name: str) -> bool:
        """Drop `name` from ownership. Returns True if it was present."""
        before = len(self.artifacts)
        self.artifacts = [a for a in self.artifacts if a.name != name]
        return len(self.artifacts) != before

    # --- serialization -----------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "remote": self.remote,
            "surface": self.surface,
            "artifacts": [a.to_dict() for a in self.artifacts],
            "written_at": self.written_at,
        }


def read_sidecar(remote_id: str, surface: str) -> RemoteSidecar:
    """Load the sidecar; a missing OR corrupt file yields an EMPTY one (never raises)."""
    empty = RemoteSidecar(remote=remote_id, surface=surface)
    path = sidecar_path(remote_id, surface)
    if not path.exists():
        return empty
    try:
        with open(path) as f:
            data = json.load(f)
        artifacts = []
        for raw in data.get("artifacts") or []:
            try:
                artifacts.append(ArtifactRecord.from_dict(raw))
            except (KeyError, TypeError, ValueError):
                # Skip individual malformed records rather than failing the
                # whole read — preserve as much ownership info as is parseable.
                continue
        return RemoteSidecar(
            remote=str(data.get("remote", remote_id)),
            surface=str(data.get("surface", surface)),
            artifacts=artifacts,
            version=int(data.get("version", SIDECAR_VERSION)),
            written_at=str(data.get("written_at", "")),
        )
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return empty


def write_sidecar(sidecar: RemoteSidecar) -> Path:
    """Atomically persist `sidecar` (sibling temp + os.replace). Returns its path."""
    sidecar.written_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    path = sidecar_path(sidecar.remote, sidecar.surface)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(sidecar.to_dict(), f, indent=2, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return path


def delete_sidecar(remote_id: str, surface: str) -> bool:
    """Remove a sidecar file. Returns True if it existed."""
    path = sidecar_path(remote_id, surface)
    if not path.exists():
        return False
    path.unlink()
    return True
