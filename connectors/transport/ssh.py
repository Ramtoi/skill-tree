"""Hardened SSH/SCP transport — a thin wrapper over the system `ssh`/`scp`.

Security contract (spec: "Host-key pinning enforced over hardened SSH transport"):
  - Connects via ssh-agent + a `~/.ssh/config` host alias (no app-owned private
    key is ever stored).
  - `StrictHostKeyChecking=yes` against a **hub-owned `UserKnownHostsFile`** under
    `<data_home>/state/ssh/known_hosts` (NOT the user's `~/.ssh/known_hosts`).
  - The pinned `host_key_sha256` from the registry is verified before any read
    or write; a mismatch HARD-FAILS (no remote artifact is touched).
  - Remote writes are atomic: content is staged to a remote temp path and
    renamed into place (`mv -f`).

The subprocess runner is **injectable** (`runner=` on the constructor) so tests
drive the wrapper without a real SSH connection. No connection is made at import
or construction — only when a method runs.
"""

from __future__ import annotations

import itertools
import os
import posixpath
import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

#: Process-wide monotonic counter for unpredictable-but-deterministic-per-call
#: temp suffixes (combined with the pid). Avoids `os.urandom`-at-import issues
#: and `Math.random`; just needs to differ across concurrent writers on a shared
#: box so a temp-symlink TOCTOU can't be pre-planted at a guessable path.
_TMP_COUNTER = itertools.count()


def posixpath_join(*parts: str) -> str:
    """Join remote (always POSIX) path components."""
    return posixpath.join(*parts)


# ─────────────────────────────────────────────────────────────────────────────
# Batched remote hashing (one round-trip for N artifacts).
#
# Each snippet reads NUL-separated keys from stdin and emits one
# `<key><TAB><sha-or-dash>` line per key on stdout. `-` marks an absent target.
# The snippets use only chr()-encoded control bytes and double-quotes so the
# whole program can be single-quoted for the remote shell. They require a remote
# `python3`; if it is missing the invocation exits non-zero and the caller falls
# back to the per-artifact primitives.
# ─────────────────────────────────────────────────────────────────────────────

#: Batch skill-dir digest. argv[1] = base dir; stdin = NUL-separated leaf names.
#: For each `<base>/<name>` it reproduces `SshTransport.dir_sha256` EXACTLY:
#: the same regular-file set (mirrors `find . -type f`: regular files at any
#: depth, excluding symlinks), the same sorted relpaths, the same utf-8-replace
#: read round-trip (mirrors `read()`), and the same 8-byte length-prefix
#: framing — so the batched digest is byte-identical to the per-artifact one.
#: (The whole program is `shlex.quote`d for the remote shell, so its embedded
#: quotes/newlines are safe.)
_DIR_SHA_BATCH_PY = r'''
import sys, os, hashlib
base = sys.argv[1]
for name in sys.stdin.buffer.read().split(b"\0"):
    if not name:
        continue
    name = name.decode("utf-8", "surrogateescape")
    d = os.path.join(base, name)
    if not os.path.isdir(d):
        sys.stdout.write(name + "\t-\n")
        continue
    rels = []
    for root, dirs, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            rels.append(os.path.relpath(p, d))
    h = hashlib.sha256()
    for rel in sorted(rels):
        with open(os.path.join(d, rel), "rb") as fh:
            data = fh.read()
        data = data.decode("utf-8", "replace").encode("utf-8")
        rb = rel.encode("utf-8")
        h.update(len(rb).to_bytes(8, "big")); h.update(rb)
        h.update(len(data).to_bytes(8, "big")); h.update(data)
    sys.stdout.write(name + "\t" + h.hexdigest() + "\n")
'''

#: Batch file digest. stdin = NUL-separated absolute paths. For each existing
#: regular file it emits the raw-bytes sha256 — byte-identical to
#: `SshTransport.sha256` (which shells out to sha256sum/shasum over raw bytes).
_FILE_SHA_BATCH_PY = r'''
import sys, os, hashlib
for p in sys.stdin.buffer.read().split(b"\0"):
    if not p:
        continue
    p = p.decode("utf-8", "surrogateescape")
    if not os.path.isfile(p):
        sys.stdout.write(p + "\t-\n")
        continue
    with open(p, "rb") as fh:
        sys.stdout.write(p + "\t" + hashlib.sha256(fh.read()).hexdigest() + "\n")
'''


def _parse_name_sha_lines(text: str, requested) -> dict[str, Optional[str]]:
    """Parse `<key><TAB><sha-or-dash>` lines into `{key: sha-or-None}`.

    Only keys in `requested` are kept (a defence against a malformed/injected
    line). `-` (a bare dash) decodes to None (absent target). The key is taken as
    everything left of the LAST tab, so a key containing a tab still parses.
    Blank and tab-less lines are skipped. A key absent from the output is simply
    left out of the result → the caller falls back to the per-artifact primitive
    for it, so partial/garbled output degrades safely rather than lying.
    """
    wanted = set(requested)
    out: dict[str, Optional[str]] = {}
    for line in text.splitlines():
        if not line:
            continue
        key, sep, sha = line.rpartition("\t")
        if not sep:
            continue
        if key not in wanted:
            continue
        out[key] = None if sha == "-" else sha
    return out


class HostKeyMismatch(RuntimeError):
    """The live host key does not match the pinned `host_key_sha256`."""


class SshCommandError(RuntimeError):
    """A remote command exited non-zero."""

    def __init__(self, argv: Sequence[str], returncode: int, stderr: str):
        # Never echo the full argv blindly if it might carry sensitive content;
        # argv here is only ssh/scp flags + remote shell commands (no secrets —
        # auth is via ssh-agent), so it is safe to surface for diagnostics.
        super().__init__(f"ssh command failed (exit {returncode}): {stderr.strip()}")
        self.argv = list(argv)
        self.returncode = returncode
        self.stderr = stderr


@dataclass(frozen=True)
class RunResult:
    """Normalized result of a subprocess invocation."""

    returncode: int
    stdout: str = ""
    stderr: str = ""


#: A runner takes an argv list (+ optional stdin bytes) and returns a RunResult.
Runner = Callable[..., RunResult]


def _default_runner(argv: Sequence[str], *, input: Optional[bytes] = None) -> RunResult:
    """Default runner: shells out to the real subprocess (never at import)."""
    proc = subprocess.run(
        list(argv),
        input=input,
        capture_output=True,
    )
    return RunResult(
        returncode=proc.returncode,
        stdout=proc.stdout.decode("utf-8", "replace") if proc.stdout else "",
        stderr=proc.stderr.decode("utf-8", "replace") if proc.stderr else "",
    )


def known_hosts_path() -> Path:
    """Hub-owned UserKnownHostsFile under the data home (NOT ~/.ssh/known_hosts)."""
    import hub  # local import to avoid a cycle

    return hub.data_home() / "state" / "ssh" / "known_hosts"


# SSH-keyscan / `ssh -o` style fingerprints look like "SHA256:<base64>".
_FPR_RE = re.compile(r"SHA256:[A-Za-z0-9+/=]+")


def _pin_set(host_key_sha256) -> set[str]:
    """Normalize a pin (None | str | iterable of str) into a set of fingerprints.

    H2.3 multi-host-key pinning: a box advertises an ed25519 AND an rsa key, and
    a legitimate key-type change should not read as a mismatch. The pin may be a
    single `"SHA256:…"` string or a list/tuple of them; any pinned fingerprint
    matching the live key is accepted.
    """
    if not host_key_sha256:
        return set()
    if isinstance(host_key_sha256, str):
        return {host_key_sha256.strip()} if host_key_sha256.strip() else set()
    out: set[str] = set()
    for fpr in host_key_sha256:
        if fpr and str(fpr).strip():
            out.add(str(fpr).strip())
    return out


class SshTransport:
    """Stateless-ish SSH/SCP wrapper for one `host` (an ssh alias or user@host)."""

    def __init__(
        self,
        host: str,
        *,
        host_key_sha256: Optional[str] = None,
        runner: Optional[Runner] = None,
        known_hosts: Optional[Path] = None,
    ):
        self.host = host
        self.host_key_sha256 = host_key_sha256
        self._runner: Runner = runner or _default_runner
        self._known_hosts = known_hosts  # resolved lazily so import stays clean
        self._verified = False  # host-key pin verified+seeded once per instance

    # --- argv construction --------------------------------------------------

    def _known_hosts_file(self) -> Path:
        return self._known_hosts if self._known_hosts is not None else known_hosts_path()

    def _control_path(self) -> Optional[str]:
        """A SHORT ControlPath under `<data_home>/state/ssh/` (or None on failure).

        Connection multiplexing is a pure speedup: N ops against the same box
        reuse ONE TCP+SSH+auth handshake instead of paying it per round-trip. We
        use ssh's `%C` token (a short fixed-length hash of the connection tuple)
        so the socket path stays well under the macOS `sun_path` ~104-char limit.
        If the dir cannot be created we return None and simply omit the mux opts —
        ssh then opens a fresh connection (slower, still correct). We never add
        custom retry logic; ssh's own auto-fallback (ControlMaster=auto) handles a
        stale/broken socket.
        """
        try:
            d = self._known_hosts_file().parent  # <data_home>/state/ssh
            d.mkdir(parents=True, exist_ok=True)
            try:
                d.chmod(0o700)
            except OSError:
                pass
            return f"{d}/%C"
        except Exception:
            return None

    def _ssh_opts(self) -> list[str]:
        """The hardened option set applied to every ssh/scp invocation.

        Beyond the host-key pinning options, every connection is time-BOUNDED
        (`ConnectTimeout` + keepalives so an asleep/unreachable box fails fast
        instead of hanging on the OS TCP timeout) and MULTIPLEXED (`ControlMaster`
        so a plan's many per-artifact round-trips share one handshake).
        """
        kh = self._known_hosts_file()
        opts = [
            "-o", "StrictHostKeyChecking=yes",
            "-o", "BatchMode=yes",
            "-o", f"UserKnownHostsFile={kh}",
            # Bound the connection: fail fast rather than hang on an unreachable
            # or asleep box (ConnectTimeout caps the TCP connect; the keepalives
            # tear down a mid-op stall after ~ServerAliveInterval*CountMax = 10s).
            "-o", "ConnectTimeout=5",
            "-o", "ServerAliveInterval=5",
            "-o", "ServerAliveCountMax=2",
        ]
        ctl = self._control_path()
        if ctl:
            opts += [
                "-o", "ControlMaster=auto",
                "-o", f"ControlPath={ctl}",
                "-o", "ControlPersist=60",
            ]
        return opts

    def _ssh_argv(self, remote_cmd: str) -> list[str]:
        return ["ssh", *self._ssh_opts(), self.host, remote_cmd]

    def _run(self, argv: Sequence[str], *, input: Optional[bytes] = None) -> RunResult:
        return self._runner(argv, input=input)

    def _run_checked(self, argv: Sequence[str], *, input: Optional[bytes] = None) -> RunResult:
        res = self._run(argv, input=input)
        if res.returncode != 0:
            raise SshCommandError(argv, res.returncode, res.stderr)
        return res

    # --- host-key pin / verify ---------------------------------------------

    def _resolve_host_port(self) -> tuple[str, str]:
        """Resolve the real hostname + port behind `self.host` via `ssh -G`.

        `self.host` may be `user@alias` where `alias` is only defined in
        `~/.ssh/config` — `ssh-keyscan` can't expand that, so we ask ssh itself
        for the effective config. Falls back to stripping a `user@` prefix.
        """
        res = self._run(["ssh", "-G", self.host])
        host = self.host.split("@", 1)[-1]
        port = "22"
        if res.returncode == 0 and res.stdout:
            for line in res.stdout.splitlines():
                k, _, v = line.strip().partition(" ")
                if k == "hostname" and v:
                    host = v
                elif k == "port" and v:
                    port = v
        return host, port

    def _scan_key_lines(self) -> list[tuple[str, str]]:
        """ssh-keyscan the RESOLVED host → list of (known_hosts_line, fingerprint)."""
        host, port = self._resolve_host_port()
        scan = self._run(["ssh-keyscan", "-p", port, "-t", "ed25519,rsa", host])
        if scan.returncode != 0 or not scan.stdout:
            return []
        out: list[tuple[str, str]] = []
        for line in scan.stdout.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            fp = self._run(["ssh-keygen", "-lf", "-"], input=(line + "\n").encode())
            m = _FPR_RE.search(fp.stdout or "")
            if m:
                out.append((line, m.group(0)))
        return out

    def fetch_host_key_fingerprint(self) -> Optional[str]:
        """Return the live SHA256 host-key fingerprint (TOFU onboarding).

        Prefers the ed25519 key; otherwise the first parsed fingerprint.
        """
        lines = self._scan_key_lines()
        if not lines:
            return None
        for line, fpr in lines:
            if "ssh-ed25519" in line:
                return fpr
        return lines[0][1]

    def pinned_fingerprints(self) -> set[str]:
        """The configured pin(s) as a set (empty when unpinned). Multi-key aware."""
        return _pin_set(self.host_key_sha256)

    def _seed_known_hosts(self, lines: list[tuple[str, str]]) -> None:
        """Append ONLY the pinned key line(s) to the hub-owned known_hosts.

        F5: a single `ssh-keyscan` returns every key type the box advertises
        (e.g. an ed25519 AND an rsa key), but we only seed line(s) whose
        fingerprint is in the PINNED set. Seeding an un-pinned line would silently
        trust a key that was never pinned, so StrictHostKeyChecking=yes would
        accept a future connection presenting it.

        H2.3 multi-key: the pin may be a SET of fingerprints (ed25519 AND rsa), in
        which case every matching line is seeded — so a later key-type change is
        not a false mismatch. When no pin is configured (TOFU) nothing is seeded.
        """
        pinned_fprs = self.pinned_fingerprints()
        if not pinned_fprs:
            return
        pinned = [
            (ln, fpr) for (ln, fpr) in lines if fpr in pinned_fprs
        ]
        kh = self._known_hosts_file()
        kh.parent.mkdir(parents=True, exist_ok=True)
        existing = kh.read_text() if kh.exists() else ""
        add = [ln for ln, _ in pinned if ln and ln not in existing]
        if add:
            with kh.open("a") as f:
                if existing and not existing.endswith("\n"):
                    f.write("\n")
                f.write("\n".join(add) + "\n")
        try:
            kh.chmod(0o600)
        except OSError:
            pass

    def pin_host_key(self, fingerprint: str) -> str:
        """Record `fingerprint` as the pin for this transport (returns it).

        Persisting it to the registry is the caller's job; this only sets the
        in-memory pin so subsequent verify() calls enforce it.
        """
        object.__setattr__(self, "host_key_sha256", fingerprint)
        return fingerprint

    def verify_host_key(self) -> None:
        """Enforce the pin: raise HostKeyMismatch if the live fpr differs.

        With no pin configured this is a no-op (an unpinned transport is only
        valid during the TOFU onboarding step, before a pin exists).
        """
        if getattr(self, "_verified", False):
            return
        pinned_fprs = self.pinned_fingerprints()
        if not pinned_fprs:
            return
        lines = self._scan_key_lines()
        if not lines:
            raise HostKeyMismatch(
                f"could not read host key for {self.host!r} to verify the pin"
            )
        # H2.3: accept the live key if ANY pinned fingerprint matches (ed25519 OR
        # rsa). Only an entirely-unpinned live key is a mismatch.
        if not any(fpr in pinned_fprs for _, fpr in lines):
            pins = ", ".join(sorted(pinned_fprs))
            raise HostKeyMismatch(
                f"host key for {self.host!r} does not match the pinned "
                f"fingerprint(s) ({pins})"
            )
        # Pin matched → seed the hub-owned known_hosts so StrictHostKeyChecking=yes
        # ops succeed, and cache so we scan only once per transport instance.
        self._seed_known_hosts(lines)
        self._verified = True

    # --- remote primitives --------------------------------------------------

    def read(self, path: str) -> bytes:
        """Read a remote file's bytes (after verifying the host-key pin)."""
        self.verify_host_key()
        res = self._run_checked(self._ssh_argv(f"cat {shlex.quote(path)}"))
        return res.stdout.encode("utf-8")

    def sha256(self, path: str) -> Optional[str]:
        """Remote sha256 of `path` (None if the file is absent)."""
        self.verify_host_key()
        # Portable: `sha256sum` (Linux/coreutils) or `shasum -a 256` (BSD/macOS).
        # Both print "<hex>  <path>"; tolerate absence (rc != 0).
        q = shlex.quote(path)
        cmd = f"sha256sum {q} 2>/dev/null || shasum -a 256 {q} 2>/dev/null"
        res = self._run(self._ssh_argv(cmd))
        if res.returncode != 0 or not res.stdout.strip():
            return None
        return res.stdout.strip().split()[0]

    def stat(self, path: str) -> Optional[dict]:
        """Lightweight remote stat → {size, mtime} or None if absent."""
        self.verify_host_key()
        # Portable existence + size: GNU `stat -c` or BSD `stat -f`, falling back
        # to `wc -c` which exists everywhere (size only; mtime 0).
        q = shlex.quote(path)
        cmd = (
            f"stat -c '%s %Y' {q} 2>/dev/null "
            f"|| stat -f '%z %m' {q} 2>/dev/null "
            f"|| (test -e {q} && wc -c < {q} | tr -d ' ' | sed 's/$/ 0/')"
        )
        res = self._run(self._ssh_argv(cmd))
        if res.returncode != 0 or not res.stdout.strip():
            return None
        parts = res.stdout.strip().split()
        try:
            return {"size": int(parts[0]), "mtime": int(parts[1]) if len(parts) > 1 else 0}
        except (IndexError, ValueError):
            return None

    def atomic_write(self, remote_path: str, content: bytes) -> None:
        """Write `content` to `remote_path` atomically (temp + `mv -f`).

        Streams the bytes over stdin to a remote temp file in the same dir, then
        renames it into place — so a reader never sees a partial file.
        """
        self.verify_host_key()
        q = shlex.quote(remote_path)
        # Non-predictable temp suffix (pid + per-call counter) so a co-tenant on
        # a shared box cannot pre-plant a symlink at the temp path and redirect
        # the write (temp-symlink TOCTOU). Stays in the SAME dir → `mv -f` is a
        # true atomic rename. No Math.random / os.urandom-at-import.
        suffix = f".hub-tmp.{os.getpid()}.{next(_TMP_COUNTER)}"
        tmp = shlex.quote(remote_path + suffix)
        parent = shlex.quote(posixpath.dirname(remote_path) or ".")
        # Single remote shell: ensure parent dir, write stdin → temp, atomic rename.
        remote_cmd = f"mkdir -p {parent} && cat > {tmp} && mv -f {tmp} {q}"
        self._run_checked(self._ssh_argv(remote_cmd), input=content)

    def probe(self, home: str) -> bool:
        """Cheap authenticated reachability probe — `test -d <home>` style.

        Returns True when the remote command runs and the home dir exists. A
        non-zero exit (e.g. missing home) returns False rather than raising, so
        the caller can distinguish unreachable (raises) from not-ready (False).
        """
        self.verify_host_key()
        res = self._run(self._ssh_argv(f"test -d {shlex.quote(home)} && echo ok"))
        # ssh exits 255 on a connection/auth failure (vs the remote command's own
        # exit code). Treat 255 as unreachable (raise) so the caller distinguishes
        # "could not connect" from "connected but home not ready".
        if res.returncode == 255:
            raise SshCommandError(["ssh", self.host, "probe"], 255, res.stderr)
        return res.returncode == 0 and res.stdout.strip() == "ok"

    def detect_env_home(self) -> Optional[str]:
        """Echo the remote `$HERMES_HOME` if set (for out-of-the-box detection)."""
        self.verify_host_key()
        res = self._run(self._ssh_argv('printf "%s" "$HERMES_HOME"'))
        if res.returncode != 0:
            return None
        out = res.stdout.strip()
        return out or None

    def expand_user(self, path: str) -> str:
        """Expand a leading `~` to the remote `$HOME`.

        Remote paths get `shlex.quote`d before use, which would turn a literal
        `~/.hermes` into the un-expanded string `'~/.hermes'`. Resolving the
        tilde to an absolute path on the box up front keeps every downstream
        quoted path correct.
        """
        if not path.startswith("~"):
            return path
        self.verify_host_key()
        res = self._run(self._ssh_argv('printf "%s" "$HOME"'))
        home = (res.stdout or "").strip()
        if res.returncode != 0 or not home:
            return path
        return home + path[1:]

    def list_subdirs(self, path: str) -> list[str]:
        """List immediate subdirectory names of a remote dir (empty if absent).

        Uses a portable `find` (no GNU-only `-printf`) so the offline tests on a
        BSD-find host and the live Linux box behave identically: emit absolute
        dir paths, then strip the prefix client-side.
        """
        self.verify_host_key()
        cmd = (
            f"cd {shlex.quote(path)} 2>/dev/null && "
            f"find . -mindepth 1 -maxdepth 1 -type d 2>/dev/null"
        )
        res = self._run(self._ssh_argv(cmd))
        if res.returncode != 0 or not res.stdout.strip():
            return []
        out = []
        for ln in res.stdout.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            # "./name" → "name"
            out.append(ln[2:] if ln.startswith("./") else ln)
        return out

    def find_skill_dirs(self, path: str, marker: str = "SKILL.md") -> list[tuple[str, str]]:
        """Discover skill dirs at ANY depth in ONE remote call.

        A directory IS a skill iff it directly contains `marker` (SKILL.md). The
        Hermes box stores skills CATEGORY-NESTED — `<skills>/<category>/<skill>/
        SKILL.md` — so a one-level `list_subdirs` would return CATEGORIES, not
        skills, and yield zero import candidates. Worse, hashing each entry was a
        per-dir SSH round-trip (100+ skills → minutes of UI freeze).

        This issues a SINGLE `find <path> -name SKILL.md` and derives, per hit:
          * the skill dir   = dirname(<hit>)            → the `ref` (full path),
          * the candidate name = leaf dir name (basename of the skill dir).
        Returns a sorted list of `(leaf_name, full_dir_path)`. Names ONLY — no
        sha is computed (content/sha is fetched lazily only when adopted).

        Portable across GNU/BSD find (no `-printf`): emit `./rel/SKILL.md` paths,
        strip the leading `./` client-side, reject any unsafe (`..`/absolute)
        relpath (F3 — a MITM box could otherwise return an escaping path), then
        join back onto the absolute `path`.
        """
        self.verify_host_key()
        q = shlex.quote(path)
        qm = shlex.quote(marker)
        # `cd` + relative find keeps output portable; absent dir → empty (rc!=0).
        cmd = (
            f"cd {q} 2>/dev/null && "
            f"find . -type f -name {qm} 2>/dev/null"
        )
        res = self._run(self._ssh_argv(cmd))
        if res.returncode != 0 or not res.stdout.strip():
            return []
        from ..layouts.agentskills import UnsafeRelpath, safe_relpath

        seen: dict[str, str] = {}
        for ln in res.stdout.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            rel = ln[2:] if ln.startswith("./") else ln
            try:
                safe_relpath(rel)
            except UnsafeRelpath as e:
                raise SshCommandError(
                    ["find", path], 1,
                    f"refusing unsafe remote relpath {rel!r}: {e}",
                ) from e
            # rel = "<category>/<skill>/SKILL.md" (or just "<skill>/SKILL.md");
            # the skill dir is its parent, the candidate name its leaf basename.
            rel_dir = posixpath.dirname(rel)
            if not rel_dir:
                # A SKILL.md directly in <path> — the dir itself (leaf == basename
                # of `path`); skip rather than name a candidate "." (never list
                # dotdirs / the root as a skill).
                continue
            # Never surface anything under a dot-prefixed component (e.g.
            # `.git/hooks/SKILL.md`) — that's VCS/tooling junk, not a skill.
            parts = [p for p in rel_dir.split("/") if p]
            if any(p.startswith(".") for p in parts):
                continue
            leaf = parts[-1] if parts else ""
            if not leaf:
                continue
            full = posixpath_join(path, rel_dir)
            # First write wins on a name collision (deterministic via sort below).
            seen.setdefault(leaf, full)
        return sorted(seen.items())

    def list_files(self, path: str) -> list[str]:
        """List every regular file under a remote dir, relative-posix (empty if absent).

        Portable across GNU/BSD find: lists `./relpath` then strips the leading
        `./` client-side (no `-printf`).
        """
        self.verify_host_key()
        cmd = (
            f"cd {shlex.quote(path)} 2>/dev/null && "
            f"find . -type f 2>/dev/null"
        )
        res = self._run(self._ssh_argv(cmd))
        if res.returncode != 0 or not res.stdout.strip():
            return []
        out = []
        for ln in res.stdout.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            rel = ln[2:] if ln.startswith("./") else ln
            # F3: a compromised/MITM'd box could return `../../escape` from
            # `find`; reject any absolute or `..`-bearing relpath here so it can
            # never reach a join in read_remote_skill_dir / write_skill_dir.
            from ..layouts.agentskills import UnsafeRelpath, safe_relpath

            try:
                safe_relpath(rel)
            except UnsafeRelpath as e:
                raise SshCommandError(
                    ["find", path], 1,
                    f"refusing unsafe remote relpath {rel!r}: {e}",
                ) from e
            out.append(rel)
        return out

    def dir_sha256(self, path: str) -> Optional[str]:
        """Stable content sha256 over a remote skill dir (None if absent).

        Mirrors `connectors.layouts.agentskills.tree_sha256` byte-for-byte: a
        length-prefixed digest over sorted (relpath, bytes), so a dir written by
        `write_skill_dir` and read back here yields the identical sha — the
        foundation of drift comparison.
        """
        import hashlib

        files = self.list_files(path)
        if not files:
            # Distinguish absent dir from empty dir: an absent dir has no files.
            if self.stat(path) is None:
                return None
        h = hashlib.sha256()
        for rel in sorted(files):
            data = self.read(posixpath_join(path, rel))
            rb = rel.encode("utf-8")
            h.update(len(rb).to_bytes(8, "big"))
            h.update(rb)
            h.update(len(data).to_bytes(8, "big"))
            h.update(data)
        return h.hexdigest()

    def dir_sha256_batch(self, base_dir: str, names) -> dict[str, Optional[str]]:
        """Digest every `<base_dir>/<name>` skill dir in ONE ssh round-trip.

        Returns `{name: sha-or-None}` (None = absent dir), byte-identical to
        calling `dir_sha256(<base_dir>/<name>)` per name — the remote snippet
        replicates that scheme exactly (see `_DIR_SHA_BATCH_PY`). This collapses
        a plan's N-dir × (list + per-file read) round-trips into one, which is
        the bulk of the `remote diff` cost. Raises `SshCommandError` if the
        remote call fails (e.g. no `python3`) so the caller can fall back to the
        per-artifact primitive.
        """
        keys = [n for n in names if n]
        if not keys:
            return {}
        self.verify_host_key()
        remote_cmd = f"python3 -c {shlex.quote(_DIR_SHA_BATCH_PY)} {shlex.quote(base_dir)}"
        payload = b"\0".join(k.encode("utf-8") for k in keys)
        res = self._run_checked(self._ssh_argv(remote_cmd), input=payload)
        return _parse_name_sha_lines(res.stdout, keys)

    def sha256_batch(self, paths) -> dict[str, Optional[str]]:
        """Raw-bytes sha256 of every path in ONE ssh round-trip.

        Returns `{path: sha-or-None}` (None = absent/not-a-file), byte-identical
        to `sha256(path)` per path. Raises `SshCommandError` on remote failure so
        the caller can fall back to the per-path primitive.
        """
        keys = [p for p in paths if p]
        if not keys:
            return {}
        self.verify_host_key()
        remote_cmd = f"python3 -c {shlex.quote(_FILE_SHA_BATCH_PY)}"
        payload = b"\0".join(k.encode("utf-8") for k in keys)
        res = self._run_checked(self._ssh_argv(remote_cmd), input=payload)
        return _parse_name_sha_lines(res.stdout, keys)

    def read_remote_skill_dir(self, path: str):
        """Read a whole remote skill dir into a `SkillTree` (relpath → bytes)."""
        from ..layouts.agentskills import SkillTree, safe_relpath

        files: dict[str, bytes] = {}
        for rel in self.list_files(path):
            # F3 defence-in-depth: list_files already rejects unsafe rels, but
            # re-validate before joining so a future caller can't bypass it.
            safe_relpath(rel)
            files[rel] = self.read(posixpath_join(path, rel))
        name = path.rstrip("/").rsplit("/", 1)[-1]
        return SkillTree(name=name, files=files)

    def backup_on_change(self, remote_path: str, new_content: bytes) -> Optional[str]:
        """Copy the current remote file aside before a change (backup-on-change).

        No-op if the file is absent or already byte-identical to `new_content`.
        The backup is a sibling `<path>.hub-bak`. Returns the backup path or None.
        """
        self.verify_host_key()
        cur = self.sha256(remote_path)
        if cur is None:
            return None
        if self.read(remote_path) == new_content:
            return None
        bak = remote_path + ".hub-bak"
        q = shlex.quote(remote_path)
        qb = shlex.quote(bak)
        self._run_checked(self._ssh_argv(f"cp -f {q} {qb}"))
        return bak

    def remove_dir(self, path: str) -> None:
        """Recursively remove a remote dir (sidecar-scoped cleanup only)."""
        self.verify_host_key()
        self._run_checked(self._ssh_argv(f"rm -rf {shlex.quote(path)}"))

    def copy_id(self, pubkey: str) -> None:
        """Append our SSH pubkey to the remote `authorized_keys` (one-time setup).

        Mirrors `ssh-copy-id`. Done only during confirmed onboarding (D3); the
        one intentional box write before a pin exists, so the pin is NOT verified
        here.
        """
        # Append idempotently: only add the key if not already present.
        key = shlex.quote(pubkey.strip())
        remote_cmd = (
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
            "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && "
            f"grep -qxF {key} ~/.ssh/authorized_keys || echo {key} >> ~/.ssh/authorized_keys"
        )
        self._run_checked(self._ssh_argv(remote_cmd))

    def read_authorized_keys(self, ak_path: str = "~/.ssh/authorized_keys") -> list[str]:
        """Read the lines of a remote authorized_keys file (empty if absent).

        Used by `revoke_authorized_key` to show a diff before mutating. Verifies
        the host-key pin first (this reaches a real box). `ak_path` defaults to
        the current user's file; codex-workers passes root's path.
        """
        self.verify_host_key()
        q = shlex.quote(ak_path)
        res = self._run(self._ssh_argv(f"cat {q} 2>/dev/null"))
        if res.returncode != 0 or not res.stdout:
            return []
        return [ln for ln in res.stdout.splitlines()]

    def revoke_authorized_key(
        self,
        match,
        *,
        ak_path: str = "~/.ssh/authorized_keys",
    ) -> int:
        """Surgically drop only the authorized_keys line(s) matching `match`.

        H2.1 — the inverse of `copy_id`. `match` is a predicate `(line) -> bool`
        (or a literal substring); EVERY non-matching line is preserved byte-for-
        byte. The file is rewritten atomically (temp + `mv -f`) so a partial write
        is never observed. Returns the number of lines removed (0 ⇒ idempotent
        no-op). Matching is done CLIENT-side so the caller can match on the key
        comment OR the full forced-command line — never a blunt truncate.
        """
        if isinstance(match, str):
            needle = match
            pred = lambda ln: needle in ln  # noqa: E731
        else:
            pred = match

        lines = self.read_authorized_keys(ak_path)
        kept = [ln for ln in lines if not pred(ln)]
        removed = len(lines) - len(kept)
        if removed == 0:
            return 0  # idempotent: nothing matched, leave the file untouched

        # Rewrite atomically. Preserve a trailing newline (authorized_keys lines
        # are newline-terminated). An empty result writes an empty file (the key
        # was the only line) rather than deleting the file.
        new_content = ("\n".join(kept) + "\n").encode("utf-8") if kept else b""
        # Resolve a leading ~ so the atomic temp sibling lands in the right dir.
        resolved = self.expand_user(ak_path)
        self.atomic_write(resolved, new_content)
        return removed
