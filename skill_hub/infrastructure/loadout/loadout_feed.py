"""Signed, fast-forward-only Git publication without checking out feed content."""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from skill_hub.domain.loadout.loadout_profiles import ProfileError, binding_digest, canonical, strict_json
from skill_hub.infrastructure.connectors.signing import get_public_key, sign_manifest, verify_manifest
from skill_hub.infrastructure.registry.project_repository import validate_repository_association

FEED_ERRORS = {
    "feed_host_key_untrusted": (
        "Git host key is not trusted. Verify the Git server fingerprint on this machine, "
        "or use HTTPS with an existing login."
    ),
    "feed_authentication_failed": (
        "Git authentication failed. Give this machine repository access. "
        "GitHub HTTPS can use an existing gh login; SSH needs an authorized key."
    ),
    "feed_repository_unavailable": (
        "Git repository is unavailable. Check its URL and this machine's access to the private repository."
    ),
    "feed_unavailable": "Git could not access the feed. Check network connectivity and repository access, then retry.",
}

# Codes from `read`/`accept` that indicate a head was NOT produced by this
# controller's own signed chain: an unverifiable signature, a feed id or
# receiver id that does not match, or a structurally invalid publication.
# Every other code (transport failures, staleness, integrity errors against a
# known prior) is a real problem and must never be treated as "foreign".
FOREIGN_HEAD_CODES = {"feed_signature_invalid", "feed_identity_mismatch", "feed_invalid"}

NAMESPACE = "skill-hub-loadouts-v1"
MAX_MANIFEST = 1024 * 1024
MAX_ASSET = 16 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_ASSETS = 10000
_HEX = re.compile(r"[a-f0-9]{64}")
_COMMIT = re.compile(r"[a-f0-9]{40,64}")


def asset_digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def validate_projection(value: dict, assets: dict[str, bytes]) -> None:
    if (
        not isinstance(value, dict)
        or set(value)
        != (
            {"schema", "feed_id", "receiver_id", "generation", "previous", "bindings", "retired", "assets"}
            | ({"capabilities"} if value.get("schema") == 2 else set())
        )
        or type(value["schema"]) is not int
        or value["schema"] not in (1, 2)
        or type(value["generation"]) is not int
        or value["generation"] < 1
        or not isinstance(value["feed_id"], str)
        or not re.fullmatch(r"[a-f0-9]{32}", value["feed_id"])
        or not isinstance(value["receiver_id"], str)
        or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value["receiver_id"])
        or (
            value["previous"] is not None
            and (not isinstance(value["previous"], str) or not _COMMIT.fullmatch(value["previous"]))
        )
        or not isinstance(value["bindings"], dict)
        or len(value["bindings"]) > 64
        or not isinstance(value["retired"], dict)
        or len(value["retired"]) > 64
        or not isinstance(value["assets"], dict)
        or len(value["assets"]) > MAX_ASSETS
        or set(value["assets"]) != set(assets)
        or len(canonical(value)) > MAX_MANIFEST
    ):
        raise ProfileError("feed_invalid", "The loadout projection has an invalid schema or exceeds its limits.")
    if value["schema"] == 2 and (
        not isinstance(value["capabilities"], str) or not _HEX.fullmatch(value["capabilities"])
    ):
        raise ProfileError("feed_invalid", "Invalid native capability identity.")
    total = 0
    for digest, content in assets.items():
        size = value["assets"][digest]
        if (
            not isinstance(digest, str)
            or not _HEX.fullmatch(digest)
            or type(size) is not int
            or not 0 <= size <= MAX_ASSET
            or not isinstance(content, bytes)
            or len(content) != size
            or asset_digest(content) != digest
        ):
            raise ProfileError("feed_invalid", "A declared asset has an invalid size or digest.")
        total += size
        if total > MAX_TOTAL:
            raise ProfileError("feed_invalid", "The loadout projection exceeds the total asset limit.")

    referenced = set()
    file_count = 0
    for name, record in value["bindings"].items():
        if not isinstance(record, dict) or set(record) != (
            {"proposal", "confirmation", "files"} | ({"native"} if value["schema"] == 2 else set())
        ):
            raise ProfileError("feed_invalid", "Invalid binding projection.")
        proposal = record["proposal"]
        fields = {"mode", "source_fingerprint", "destination_key", "harnesses"}
        if isinstance(proposal, dict) and proposal.get("mode") == "repository":
            fields |= {"source_repository", "destination_repository"}
        from skill_hub.domain.loadout.loadout_native_codec import selections

        if isinstance(proposal, dict):
            fields |= set(selections(proposal))
        if not isinstance(proposal, dict) or set(proposal) != fields:
            raise ProfileError("feed_invalid", "Invalid binding authorization inputs.")
        digest = binding_digest(name, proposal)
        receipt = record["confirmation"]
        if (
            not isinstance(receipt, dict)
            or set(receipt) != {"receiver_id", "installation_id", "profile_revision", "binding_digest", "observed_at"}
            or receipt["receiver_id"] != value["receiver_id"]
            or receipt["binding_digest"] != digest
            or not isinstance(receipt["installation_id"], str)
            or not re.fullmatch(r"[a-f0-9-]{36}", receipt["installation_id"])
            or type(receipt["profile_revision"]) is not int
            or receipt["profile_revision"] < 1
            or not isinstance(receipt["observed_at"], str)
            or len(receipt["observed_at"]) > 64
        ):
            raise ProfileError("feed_invalid", "Invalid receiver confirmation.")
        if not isinstance(record["files"], list):
            raise ProfileError("feed_invalid", "Invalid binding file list.")
        seen = set()
        for item in record["files"]:
            if (
                not isinstance(item, dict)
                or set(item) != {"scope", "harness", "area", "name", "path", "asset", "mode"}
                or item["scope"] not in ("project", "global")
                or item["harness"] not in proposal["harnesses"]
                or item["area"] != "skills"
                or not isinstance(item["name"], str)
                or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", item["name"])
                or not isinstance(item["asset"], str)
                or item["asset"] not in assets
                or type(item["mode"]) is not int
                or item["mode"] not in {0o644, 0o755}
            ):
                raise ProfileError("feed_invalid", "Invalid projected file.")
            relative = safe_asset_path(item["path"])
            if item["mode"] == 0o755 and not relative.startswith("scripts/"):
                raise ProfileError("feed_invalid", "Only skill scripts may carry executable permission.")
            key = (item["scope"], item["harness"], item["name"], relative)
            if key in seen:
                raise ProfileError("feed_invalid", "A projected file is repeated.")
            seen.add(key)
            referenced.add(item["asset"])
            file_count += 1
            if file_count > MAX_ASSETS:
                raise ProfileError("feed_invalid", "The projection contains too many files.")
        if value["schema"] == 2:
            from skill_hub.domain.loadout.loadout_native_codec import decode_unit

            if not isinstance(record["native"], list) or len(record["native"]) > 4096:
                raise ProfileError("feed_invalid", "Invalid native unit list.")
            native_seen = set()
            for unit in record["native"]:
                decode_unit(unit, assets)
                identity = tuple(unit[k] for k in ("scope", "harness", "area", "key"))
                if (
                    identity in native_seen
                    or unit["harness"] not in proposal["harnesses"]
                    or (unit["scope"] == "global" and unit["area"] not in proposal.get("global_native", []))
                ):
                    raise ProfileError("feed_invalid", "Native authority is missing or repeated.")
                if (
                    unit["scope"] == "global"
                    and unit["area"] == "agents"
                    and unit["key"] not in proposal.get("global_agents", [])
                ):
                    raise ProfileError("feed_invalid", "Global agent selection is missing.")
                native_seen.add(identity)
                referenced.add(unit["asset"])
    for name, disposition in value["retired"].items():
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name)
            or name in value["bindings"]
            or disposition != "retain"
        ):
            raise ProfileError("feed_invalid", "Invalid binding retirement directive.")
    if referenced != set(assets):
        raise ProfileError("feed_invalid", "The feed contains unreferenced assets.")


def safe_asset_path(value: str) -> str:
    from pathlib import PurePosixPath

    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or any(ord(char) < 32 for char in value)
        or value.startswith("/")
        or any(part in {"", ".", "..", ".git"} for part in value.split("/"))
        or PurePosixPath(value).as_posix() != value
    ):
        raise ProfileError("unsafe_asset_path", "An asset has an unsafe relative path.")
    return value


class GitFeed:
    """One pinned feed/ref, with a private bare object cache and no worktree.

    `allow_local` is for isolated fixture repositories. Public CLI callers never
    enable it. The receiver's credentials are configured outside the feed.
    """

    def __init__(self, cache: Path, url: str, receiver_id: str, *, allow_local: bool = False):
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", receiver_id):
            raise ProfileError("feed_invalid", "Invalid receiver id.")
        if url.lower().startswith("http://"):
            raise ProfileError("feed_invalid", "Private feeds require SSH or HTTPS.")
        if not (allow_local and Path(url).is_absolute()):
            validate_repository_association({"url": url, "remote": "origin", "subdirectory": "."})
        parsed = urlsplit(url)
        if parsed.scheme == "https" and parsed.hostname == "github.com" and parsed.port in (None, 443):
            url = parsed._replace(netloc="github.com").geturl()
        self.cache, self.url = cache, url
        self.receiver_id = receiver_id
        self.ref = "refs/heads/" + receiver_id
        self.allow_local = allow_local

    def _git(self, *args: str, input: Optional[bytes] = None, allowed=(0,)) -> bytes:
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(
            {
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
                "GIT_AUTHOR_NAME": "Skill Tree",
                "GIT_AUTHOR_EMAIL": "loadouts@localhost",
                "GIT_COMMITTER_NAME": "Skill Tree",
                "GIT_COMMITTER_EMAIL": "loadouts@localhost",
            }
        )
        credentials = []
        if urlsplit(self.url).scheme == "https" and urlsplit(self.url).netloc == "github.com":
            from skill_hub.infrastructure.harnesses.harness_probe import resolve_binary

            gh = resolve_binary("gh")
            if gh:
                credentials = [
                    "-c",
                    "credential.helper=",
                    "-c",
                    "credential.https://github.com.helper=!" + shlex.quote(gh) + " auth git-credential",
                ]
        argv = [
            "git",
            *credentials,
            "-c",
            "core.hooksPath=" + os.devnull,
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.file.allow=" + ("always" if self.allow_local else "never"),
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "init.templateDir=",
            "-c",
            "transfer.fsckObjects=true",
            "-C",
            str(self.cache),
            *args,
        ]
        try:
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                result = subprocess.run(argv, input=input, stdout=stdout, stderr=stderr, env=env, timeout=60)
                if stdout.tell() > MAX_ASSET + 1 or stderr.tell() > MAX_MANIFEST:
                    raise ProfileError("feed_invalid", "Git returned output beyond the feed limit.")
                stdout.seek(0)
                output = stdout.read()
                stderr.seek(0)
                failure = stderr.read().decode("utf-8", "replace").lower()
        except (OSError, subprocess.TimeoutExpired):
            raise ProfileError("feed_unavailable", "Git could not access the loadout feed.") from None
        if result.returncode not in allowed:
            code = "feed_unavailable"
            if "host key verification failed" in failure or "remote host identification has changed" in failure:
                code = "feed_host_key_untrusted"
            elif any(
                term in failure
                for term in (
                    "permission denied",
                    "authentication failed",
                    "could not read username",
                    "could not read password",
                )
            ):
                code = "feed_authentication_failed"
            elif "repository not found" in failure or "does not appear to be a git repository" in failure:
                code = "feed_repository_unavailable"
            raise ProfileError(code, FEED_ERRORS[code])
        return output

    def prepare(self) -> None:
        if self.cache.is_symlink():
            raise ProfileError("feed_invalid", "The feed cache cannot be a symlink.")
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not (self.cache / "HEAD").exists():
            if any(self.cache.iterdir()):
                raise ProfileError("feed_invalid", "The feed cache directory is not empty.")
            self._git("init", "--bare", "--quiet")
        if self._git("rev-parse", "--is-bare-repository").strip() != b"true":
            raise ProfileError("feed_invalid", "The loadout cache must be a bare repository.")
        allowed_config = {
            "core.repositoryformatversion",
            "core.filemode",
            "core.bare",
            "core.logallrefupdates",
            "core.ignorecase",
            "core.precomposeunicode",
        }
        configuration = self._git("config", "--local", "--no-includes", "--null", "--list")
        for entry in configuration.split(b"\0"):
            if entry and entry.split(b"\n", 1)[0].decode() not in allowed_config:
                raise ProfileError("feed_invalid", "The private feed cache contains unexpected Git configuration.")

    def fetch(self) -> Optional[str]:
        self.prepare()
        output = self._git("ls-remote", "--refs", self.url, self.ref).decode().strip()
        if not output:
            return None
        pieces = output.split()
        if len(pieces) != 2 or pieces[1] != self.ref or not _COMMIT.fullmatch(pieces[0]):
            raise ProfileError("feed_invalid", "The feed returned an invalid revision.")
        revision = pieces[0]
        self._git("fetch", "--no-tags", "--no-recurse-submodules", self.url, self.ref)
        observed = self._git("rev-parse", "FETCH_HEAD").decode().strip()
        if not _COMMIT.fullmatch(observed):
            raise ProfileError("feed_invalid", "The feed returned an invalid revision.")
        # A concurrent publish may advance between ls-remote and fetch. Use the
        # fetched commit; signed generation/ancestry checks remain authoritative.
        return observed

    def _blob(self, object_id: str, maximum: int) -> bytes:
        size = self._git("cat-file", "-s", object_id).strip()
        if not size.isdigit() or int(size) > maximum:
            raise ProfileError("feed_invalid", "A feed object exceeds its size limit.")
        return self._git("cat-file", "blob", object_id)

    def read(self, revision: str, public_key: str) -> tuple[dict, dict[str, bytes]]:
        if not _COMMIT.fullmatch(revision):
            raise ProfileError("feed_invalid", "Invalid feed revision.")
        listing = self._git("ls-tree", "-r", "-z", revision)
        if len(listing) > MAX_MANIFEST * 4:
            raise ProfileError("feed_invalid", "The feed contains too many entries.")
        entries: dict[str, str] = {}
        for row in listing.split(b"\0"):
            if not row:
                continue
            try:
                metadata, raw_name = row.split(b"\t", 1)
                mode, kind, oid = metadata.decode().split()
                name = raw_name.decode("utf-8")
            except (ValueError, UnicodeError):
                raise ProfileError("feed_invalid", "Invalid feed tree entry.") from None
            if mode != "100644" or kind != "blob" or name in entries:
                raise ProfileError("feed_invalid", "The feed must contain unique regular data blobs.")
            if name not in {"projection.json", "projection.sig"} and not re.fullmatch(r"assets/[a-f0-9]{64}", name):
                raise ProfileError("feed_invalid", "The feed contains an undeclared path.")
            entries[name] = oid
            if len(entries) > MAX_ASSETS + 2:
                raise ProfileError("feed_invalid", "The feed contains too many entries.")
        if not {"projection.json", "projection.sig"}.issubset(entries):
            raise ProfileError("feed_invalid", "The signed projection is missing.")
        payload = self._blob(entries.pop("projection.json"), MAX_MANIFEST)
        signature = self._blob(entries.pop("projection.sig"), 16384)
        try:
            projection = strict_json(payload)
            if canonical(projection) != payload:
                raise ValueError()
            valid = verify_manifest(
                [("projection.json", asset_digest(payload))], signature.decode(), public_key, namespace=NAMESPACE
            )
        except (ValueError, UnicodeError):
            raise ProfileError(
                "feed_invalid", "The projection is not canonical JSON or has an invalid signature."
            ) from None
        if not valid:
            raise ProfileError(
                "feed_signature_invalid", "The projection signature does not match the pinned publisher."
            )
        assets = {}
        total = 0
        for path, oid in entries.items():
            data = self._blob(oid, MAX_ASSET)
            total += len(data)
            if total > MAX_TOTAL:
                raise ProfileError("feed_invalid", "The feed exceeds its asset limit.")
            assets[path.removeprefix("assets/")] = data
        validate_projection(projection, assets)
        if projection["receiver_id"] != self.receiver_id:
            raise ProfileError("feed_identity_mismatch", "This publication is for a different receiver.")
        parents = self._git("rev-list", "--parents", "-n", "1", revision).decode().strip().split()[1:]
        expected = [projection["previous"]] if projection["previous"] else []
        if parents != expected:
            raise ProfileError("feed_invalid", "The signed publication does not match its Git parent.")
        return projection, assets

    def accept(self, revision: str, public_key: str, feed_id: str, prior: Optional[dict]) -> tuple[dict, dict]:
        projection, assets = self.read(revision, public_key)
        if projection["feed_id"] != feed_id:
            raise ProfileError("feed_identity_mismatch", "This publication belongs to a different feed.")
        if prior:
            if prior["feed_id"] != feed_id or projection["generation"] < prior["generation"]:
                raise ProfileError("stale_publication", "An older publication cannot replace the accepted generation.")
            if projection["generation"] == prior["generation"]:
                if revision != prior["revision"] or asset_digest(canonical(projection)) != prior["digest"]:
                    raise ProfileError("feed_integrity_error", "The same generation has different signed content.")
            elif not self.descendant(revision, prior["revision"]):
                raise ProfileError(
                    "feed_integrity_error", "The publication does not descend from the accepted revision."
                )
        return projection, assets

    def descendant(self, revision: str, ancestor: str) -> bool:
        if not _COMMIT.fullmatch(revision) or not _COMMIT.fullmatch(ancestor):
            return False
        merge_base = self._git("merge-base", revision, ancestor, allowed=(0, 1)).decode().strip()
        return merge_base == ancestor

    def publish(
        self, projection: dict, assets: dict[str, bytes], *, parent: Optional[str], replace_foreign: bool = False
    ) -> str:
        validate_projection(projection, assets)
        if projection["receiver_id"] != self.receiver_id:
            raise ProfileError("feed_identity_mismatch", "The publication belongs to a different receiver.")
        if replace_foreign:
            if parent is None:
                raise ProfileError("feed_invalid", "A reconnected feed must graft onto an existing head.")
            if projection["generation"] != 1 or projection["previous"] != parent:
                raise ProfileError(
                    "feed_integrity_error", "A reconnected feed starts at generation one on the current head."
                )
        elif projection["previous"] != parent:
            raise ProfileError("feed_invalid", "The projection does not reference the prior publication.")
        observed = self.fetch()
        if observed != parent:
            raise ProfileError("feed_advanced", "The feed advanced; rebuild this publication before retrying.")
        if replace_foreign:
            public_key = get_public_key()
            if not public_key:
                raise ProfileError("signing_required", "Initialize the publisher signing key before publishing.")
            try:
                prior, _ = self.read(parent, public_key)
                foreign = prior["feed_id"] != projection["feed_id"]
            except ProfileError as exc:
                if exc.code not in FOREIGN_HEAD_CODES:
                    raise
                foreign = True
            if not foreign:
                raise ProfileError(
                    "feed_integrity_error", "The feed head already belongs to this controller; publish normally."
                )
            # A foreign parent has no continuity with this feed id; skip the
            # normal "prior generation + 1" advancement check.
        elif parent:
            public_key = get_public_key()
            if not public_key:
                raise ProfileError("signing_required", "Initialize the publisher signing key before publishing.")
            prior, _ = self.read(parent, public_key)
            if projection["feed_id"] != prior["feed_id"] or projection["generation"] != prior["generation"] + 1:
                raise ProfileError("feed_integrity_error", "Publication must advance this feed by one generation.")
        elif projection["generation"] != 1:
            raise ProfileError("feed_integrity_error", "A new feed starts at generation one.")
        payload = canonical(projection)
        signature = sign_manifest([("projection.json", asset_digest(payload))], namespace=NAMESPACE).encode()

        def blob(data):
            return self._git("hash-object", "-w", "--stdin", input=data).decode().strip()

        asset_tree = (
            self._git(
                "mktree",
                "-z",
                input=b"".join(
                    f"100644 blob {blob(content)}\t{digest}\0".encode() for digest, content in sorted(assets.items())
                ),
            )
            .decode()
            .strip()
        )
        root = (
            self._git(
                "mktree",
                "-z",
                input=(
                    f"040000 tree {asset_tree}\tassets\0"
                    f"100644 blob {blob(payload)}\tprojection.json\0"
                    f"100644 blob {blob(signature)}\tprojection.sig\0"
                ).encode(),
            )
            .decode()
            .strip()
        )
        commit = (
            self._git("commit-tree", root, *(["-p", parent] if parent else []), input=b"Publish project loadouts\n")
            .decode()
            .strip()
        )
        # No --force or backup tip adoption. A concurrent writer fails here.
        self._git("push", "--porcelain", self.url, commit + ":" + self.ref)
        return commit
