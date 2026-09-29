"""Journaled receiver writes with checked preimages and conservative recovery.

Call under the receiver-wide lock. Plans contain only paths derived from the
receiver profile, never paths accepted directly from a publication.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from skill_hub.domain.loadout.loadout_profiles import ProfileError, atomic_json, canonical, strict_json

MAX_FILE = 16 * 1024 * 1024
MAX_JOURNAL = 384 * 1024 * 1024
MAX_IMAGES = 128 * 1024 * 1024


class ImageBudget:
    """Bound expanded preimages and postimages before allocating base64 copies."""

    def __init__(self) -> None:
        self.used = 0

    def reserve(self, raw_size: int) -> None:
        self.used += 4 * ((raw_size + 2) // 3)
        if self.used > MAX_IMAGES:
            raise ProfileError("invalid_write_plan", "Expanded receiver files exceed the delivery size limit.")


@dataclass(frozen=True)
class Image:
    kind: str
    content: str = ""
    mode: int = 0

    @classmethod
    def file(cls, data: bytes, mode: int = 0o644, *, budget: Optional[ImageBudget] = None) -> "Image":
        if len(data) > MAX_FILE:
            raise ProfileError("artifact_too_large", "A receiver artifact exceeds the size limit.")
        if budget is not None:
            budget.reserve(len(data))
        return cls("file", base64.b64encode(data).decode(), mode)


@dataclass(frozen=True)
class FileMutation:
    path: Path
    before: Image
    after: Image
    owner_key: str


@contextmanager
def _parent(path: Path, roots: tuple[Path, ...], *, create: bool = False) -> Iterator[tuple[int, str]]:
    if not path.is_absolute() or ".." in path.parts:
        raise ProfileError("write_confinement", "A planned destination is outside the approved roots.")
    root = next((root for root in roots if root in path.parents), None)
    if root is None:
        raise ProfileError("write_confinement", "A planned destination is outside the approved roots.")
    parts = path.relative_to(root).parts
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o755, dir_fd=directory)
                os.fsync(directory)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory, parts[-1]
    except OSError as exc:
        if exc.errno in (20, 40):  # ENOTDIR/ELOOP, including a directory symlink.
            raise ProfileError("write_confinement", "A planned destination traverses a symlink.") from None
        raise
    finally:
        os.close(directory)


def _image(directory: int, name: str, budget: Optional[ImageBudget] = None) -> Image:
    try:
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return Image("missing")
    if stat.S_ISLNK(info.st_mode):
        return Image("symlink", os.readlink(name, dir_fd=directory))
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
        raise ProfileError("unsupported_artifact", "A managed destination is not a bounded regular file.")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        data = stream.read(MAX_FILE + 1)
        mode = stat.S_IMODE(os.fstat(stream.fileno()).st_mode)
    return Image.file(data, mode, budget=budget)


def snapshot(path: Path, roots: tuple[Path, ...], *, budget: Optional[ImageBudget] = None) -> Image:
    try:
        with _parent(path, roots) as (directory, name):
            return _image(directory, name, budget)
    except FileNotFoundError:
        return Image("missing")


def _write(mutation: FileMutation, roots: tuple[Path, ...]) -> None:
    with _parent(mutation.path, roots, create=True) as (directory, name):
        if _image(directory, name) != mutation.before:
            raise ProfileError("blocked_drift", "A destination changed after preparation; no overwrite was authorized.")
        if mutation.before == mutation.after:
            return
        after = mutation.after
        if after.kind == "missing":
            if mutation.before.kind != "missing":
                os.unlink(name, dir_fd=directory)
        else:
            temporary = ".skill-tree-" + uuid.uuid4().hex
            try:
                if after.kind == "file":
                    fd = os.open(
                        temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, after.mode, dir_fd=directory
                    )
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(base64.b64decode(after.content, validate=True))
                        os.fchmod(stream.fileno(), after.mode)
                        stream.flush()
                        os.fsync(stream.fileno())
                elif after.kind == "symlink":
                    os.symlink(after.content, temporary, dir_fd=directory)
                else:
                    raise ProfileError("invalid_write_plan", "Unknown artifact operation.")
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
        os.fsync(directory)


def _validate_image(value: dict) -> Image:
    if not isinstance(value, dict) or set(value) != {"kind", "content", "mode"}:
        raise ValueError()
    image = Image(**value)
    if type(image.mode) is not int or not 0 <= image.mode <= 0o777 or not isinstance(image.content, str):
        raise ValueError()
    if image.kind == "file":
        data = base64.b64decode(image.content, validate=True)
        if len(data) > MAX_FILE:
            raise ValueError()
    elif image.kind == "missing":
        if image.content or image.mode:
            raise ValueError()
    elif image.kind == "symlink":
        if not image.content or "\x00" in image.content or image.mode:
            raise ValueError()
    else:
        raise ValueError()
    return image


class ReceiverTransaction:
    def __init__(self, root: Path, roots: tuple[Path, ...], *, checkpoint: Optional[Callable[[str], None]] = None):
        self.root = root
        self.roots = roots
        self.journal = root / "transaction.json"
        self.applied = root / "applied.json"
        self.progress = root / "progress.json"
        self.checkpoint = checkpoint or (lambda event: None)

    def _save(self, journal: dict, phase: str) -> None:
        journal["phase"] = phase
        atomic_json(self.journal, journal)
        self.checkpoint("journal:" + phase)

    def read_applied(self) -> Optional[dict]:
        if not os.path.lexists(self.applied):
            return None
        try:
            if self.applied.is_symlink() or self.applied.stat().st_size > 128 * 1024 * 1024:
                raise ValueError()
            result = strict_json(self.applied.read_bytes())
            if not isinstance(result, dict) or set(result) != {"transaction_id", "state"}:
                raise ValueError()
            uuid.UUID(result["transaction_id"])
            if not isinstance(result["state"], dict):
                raise ValueError()
            return result
        except (ValueError, TypeError, OSError, AttributeError):
            raise ProfileError(
                "receiver_state_invalid", "Applied receiver state is invalid; repair it locally."
            ) from None

    def recover(self, before_restore: Optional[Callable[[Path], None]] = None) -> bool:
        if not os.path.lexists(self.journal):
            return False
        try:
            if self.journal.is_symlink() or self.journal.stat().st_size > MAX_JOURNAL:
                raise ValueError()
            journal = strict_json(self.journal.read_bytes())
            if (
                not isinstance(journal, dict)
                or set(journal)
                != {"schema", "transaction_id", "phase", "plan", "plan_digest", "old_applied", "new_state"}
                or journal["schema"] != 1
                or journal["phase"]
                not in {"prepared", "applying", "committed", "recovering", "recovery_required", "rolled_back"}
            ):
                raise ValueError()
            uuid.UUID(journal["transaction_id"])
            if not isinstance(journal["new_state"], dict):
                raise ValueError()
            old = journal["old_applied"]
            if old is not None:
                if not isinstance(old, dict) or set(old) != {"transaction_id", "state"}:
                    raise ValueError()
                uuid.UUID(old["transaction_id"])
                if not isinstance(old["state"], dict):
                    raise ValueError()
            if hashlib.sha256(canonical(journal["plan"])).hexdigest() != journal["plan_digest"]:
                raise ValueError()
            if not isinstance(journal["plan"], list) or len(journal["plan"]) > 10000:
                raise ValueError()
            plan = [
                FileMutation(
                    Path(item["path"]),
                    _validate_image(item["before"]),
                    _validate_image(item["after"]),
                    item["owner_key"],
                )
                for item in journal["plan"]
            ]
        except (ValueError, KeyError, TypeError, OSError, AttributeError):
            raise ProfileError(
                "receiver_journal_invalid", "Receiver recovery journal is invalid; repair it locally."
            ) from None
        applied = self.read_applied()
        if applied and applied["transaction_id"] == journal["transaction_id"]:
            if journal["phase"] != "committed":
                self._save(journal, "committed")
            return False
        if journal["phase"] == "committed":
            raise ProfileError("receiver_state_invalid", "Committed receiver state is missing; repair it locally.")
        if applied != journal["old_applied"]:
            raise ProfileError("receiver_state_invalid", "Applied state changed during an interrupted transaction.")
        if journal["phase"] == "rolled_back":
            return False
        attempted = -1
        if journal["phase"] != "prepared":
            try:
                if self.progress.is_symlink() or self.progress.stat().st_size > 1024:
                    raise ValueError()
                progress = strict_json(self.progress.read_bytes())
                if (
                    not isinstance(progress, dict)
                    or set(progress) != {"transaction_id", "attempted"}
                    or progress["transaction_id"] != journal["transaction_id"]
                    or type(progress["attempted"]) is not int
                    or not -1 <= progress["attempted"] < len(plan)
                ):
                    raise ValueError()
                attempted = progress["attempted"]
            except (OSError, ValueError, KeyError, TypeError):
                raise ProfileError("receiver_journal_invalid", "The transaction intent record is invalid.") from None
        if journal["phase"] == "prepared":
            atomic_json(self.progress, {"transaction_id": journal["transaction_id"], "attempted": -1})
        self._save(journal, "recovering")
        blocked = False
        for mutation in reversed(plan[: attempted + 1]):
            try:
                if before_restore is not None:
                    before_restore(mutation.path)
                current = snapshot(mutation.path, self.roots)
            except (OSError, ProfileError):
                blocked = True
                continue
            if current == mutation.before:
                continue
            if current != mutation.after:
                blocked = True
                continue
            try:
                _write(FileMutation(mutation.path, mutation.after, mutation.before, mutation.owner_key), self.roots)
            except (OSError, ProfileError):
                blocked = True
        self._save(journal, "recovery_required" if blocked else "rolled_back")
        if blocked:
            raise ProfileError("partial_apply", "Recovery preserved an unknown local edit. Review it before retrying.")
        return True

    def apply(
        self,
        mutations: list[FileMutation],
        state: dict,
        *,
        validate_path: Optional[Callable[[Path], None]] = None,
    ) -> None:
        if not isinstance(state, dict):
            raise ProfileError("invalid_write_plan", "Applied state must be an object.")
        self.recover(before_restore=validate_path)
        if len(mutations) > 10000 or len({item.path for item in mutations}) != len(mutations):
            raise ProfileError("invalid_write_plan", "The write plan is too large or repeats a destination.")
        plan = []
        for item in mutations:
            if validate_path:
                validate_path(item.path)
            _validate_image(asdict(item.before))
            _validate_image(asdict(item.after))
            if item.before.kind == "symlink" or item.after.kind == "symlink":
                raise ProfileError(
                    "write_confinement", "Receiver delivery requires regular files; symlinks need review."
                )
            if snapshot(item.path, self.roots) != item.before:
                raise ProfileError("blocked_drift", "A managed destination changed; review it before applying.")
            plan.append(
                {
                    "path": str(item.path),
                    "before": asdict(item.before),
                    "after": asdict(item.after),
                    "owner_key": item.owner_key,
                }
            )
        journal = {
            "schema": 1,
            "transaction_id": str(uuid.uuid4()),
            "phase": "prepared",
            "plan": plan,
            "plan_digest": "0" * 64,
            "old_applied": self.read_applied(),
            "new_state": state,
        }
        # Count incrementally before canonical() can allocate the entire plan
        # or journal. Include state, path/owner metadata and phase headroom.
        size = 128
        encoder = json.JSONEncoder(sort_keys=True, separators=(",", ":"), allow_nan=False)
        for chunk in encoder.iterencode(journal):
            size += len(chunk.encode())
            if size > MAX_JOURNAL:
                raise ProfileError("invalid_write_plan", "The transaction exceeds its recovery size limit.")
        journal["plan_digest"] = hashlib.sha256(canonical(plan)).hexdigest()
        if self.journal.exists():
            previous = strict_json(self.journal.read_bytes())
            # Keep exactly the preceding recoverable journal; periodic updates
            # must not accumulate full asset copies without bound.
            atomic_json(self.root / "history" / "previous.json", previous)
        self._save(journal, "prepared")
        atomic_json(self.progress, {"transaction_id": journal["transaction_id"], "attempted": -1})
        try:
            self._save(journal, "applying")
            for index, item in enumerate(mutations):
                self.checkpoint(f"before:{index}")
                atomic_json(self.progress, {"transaction_id": journal["transaction_id"], "attempted": index})
                self.checkpoint(f"intent:{index}")
                if validate_path:
                    validate_path(item.path)
                _write(item, self.roots)
                self.checkpoint(f"after:{index}")
            atomic_json(self.applied, {"transaction_id": journal["transaction_id"], "state": state})
            self.checkpoint("applied")
            self._save(journal, "committed")
        except Exception:
            self.recover(before_restore=validate_path)
            raise
