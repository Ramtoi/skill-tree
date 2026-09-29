"""The MCP schema axis: transport, secrets, and the per-harness mapping.

A leaf module (plans/B.md wave B, unit B1; hardened in wave E3 rev 2): at
MODULE SCOPE this imports stdlib only — never `hub_core`, `hub`, or
`skill_meta` — so a packaged build that ships no `tests/` directory can still
import it (the secret-detection patterns fall back to an inline copy of
`tests/fixtures/mcp_secret_corpus.json` when that file cannot be found).

Two readers of the registry `mcp:` block, and the difference between them is
load-bearing (grill finding F1):

- `spec_from_registry(name, cfg, *, source=None)` — the EXPANDED reader. When
  `source` is given, a `{source}` placeholder in `args` is substituted. Fed to
  `to_native` for every harness write and the (future) liveness probe.
- `raw_spec_from_registry(name, cfg)` — `spec_from_registry` with
  `source=None`, i.e. `{source}` is left UNEXPANDED. This is the ONLY spec
  that may reach `canonical_spec_dict` — the remote-connector wire format
  (`connectors/hermes.py`'s `_canonical_mcp_bytes`). Feeding the expanded
  spec there would change the sha of every scaffolded server already
  provisioned on a remote box, which is exactly the spurious 3-way drift the
  DECIDED sha-stability rule (PLAN.md) exists to prevent.

`mcp_spec.py` performs NO source lookup of its own — that needs
`skill_meta.skill_source`, which would break the stdlib-leaf rule. Callers
(`mcp_sync._spec_from_skill`, `hub.build_remote_desired_state`) pass
`skill_meta.skill_source(cfg)` only when `cfg["source"]` is truthy; the
control-plane mcp-server entry has `source: None` and absolute args, so no
substitution is attempted for it.

NOTE (observed, not documented — see `docs/SKILL-SCHEMA.md`): a server
scaffolded by `hub new mcp` carries `args: ["{source}/server.py"]`, and a
remote box receives that string UNEXPANDED — `connectors/hermes.py` pushes
the decoded payload verbatim. That is a latent bug for scaffolded servers on
remotes, out of scope for this wave, and now pinned by the sha-stability
tests below.

Wave E3 rev 2 (`plans/E3.md` §2.1/§2.2, `plans/E3.edge-cases.md` §2) adds the
ONE normaliser every door that reads a native MCP entry — `hub mcp reconcile`
import (`mcp_reconcile.py`), `hub mcp add --json-stdin`/flags
(`hub_cli/mcp.py`), and (via a corpus-pinned TS twin) the New sheet's paste
path — routes through, so a malformed or awkwardly-named entry refuses (or
repairs) identically everywhere instead of three doors disagreeing:

- `slugify_server_name(raw)` — the name axis, total (never raises,
  `None` on an unusable name).
- `normalize_native(obj, *, name=...)` — the object-shape axis, total
  (`NativeNormalization`, never raises). `parse_native` is now a thin
  exception-raising wrapper over it, kept so every pre-existing caller's
  signature and try/except still work.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from skill_hub.domain.harnesses.harness_adapter_api import McpNativeDecoder

# ─────────────────────────────────────────────────────────────────────────────
# Transport vocabulary
# ─────────────────────────────────────────────────────────────────────────────

#: The vocabulary the registry, `to_native`, and `parse_native` all speak.
TRANSPORTS = ("stdio", "http", "sse")

#: Accepted INPUT aliases — normalized on read, never emitted.
TRANSPORT_ALIASES = {"streamable-http": "http"}

#: Transports hub refuses everywhere (only Claude Code supports them; hub
#: cannot deliver one to the other three harnesses). Value = the reason word
#: `parse_native` raises `UnsupportedNativeEntry` with.
REFUSED_TRANSPORTS = {"ws": "ws_transport"}


class UnsupportedNativeEntry(Exception):
    """A native MCP entry hub cannot represent (`parse_native`).

    `reason` is a bare vocabulary word (`ws_transport`, `oauth_block`,
    `headers_helper`, `unknown_shape`, …); `detail` is optional free text
    (e.g. the offending raw `type` value). `str(exc)` renders the same
    `<reason>` / `<reason>:<detail>` grammar used by `skip_reasons`
    everywhere else in the MCP stack (INTERFACES §1 "skips semantics").
    """

    def __init__(self, reason: str, detail: Optional[str] = None) -> None:
        self.reason = reason
        self.detail = detail
        message = reason if detail is None else f"{reason}:{detail}"
        super().__init__(message)


# ─────────────────────────────────────────────────────────────────────────────
# The spec
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class McpServerSpec:
    """One MCP server, harness-agnostic.

    Field order is APPEND-ONLY (INTERFACES §1): every existing positional or
    keyword construction across the codebase must keep binding. `mcp_adapters`
    imports this class and re-exports it, so `mcp_adapters.McpServerSpec` and
    `mcp_spec.McpServerSpec` are the same object — no duplicate type.
    """

    name: str
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    cwd: Optional[str] = None
    transport: str = "stdio"
    url: Optional[str] = None
    headers: dict[str, str] = field(default_factory=dict)
    timeout_ms: Optional[int] = None
    allow_literal_secrets: bool = False


@dataclass(frozen=True)
class NativeNormalization:
    """Host-facing result retained for the existing MCP readers."""

    spec: Optional[McpServerSpec]
    reason: Optional[str]
    warnings: list[str] = field(default_factory=list)


def _bounded_detail(value: object, limit: int = 40) -> str:
    """Compatibility export for callers that used the old private helper."""
    from skill_hub.infrastructure.harnesses.harness_bundled_mcp import _bounded_detail as bundled_bounded_detail

    return bundled_bounded_detail(value, limit)


def _normalize_transport(value: object) -> Optional[str]:
    """`None` → `"stdio"`; a known alias/value → its canonical form; anything
    else (incl. `"ws"`) → `None`, the "unknown/unsupported" signal callers
    turn into their own error/exception."""
    if value is None:
        return "stdio"
    if not isinstance(value, str):
        return None
    canonical = TRANSPORT_ALIASES.get(value, value)
    if canonical in TRANSPORTS:
        return canonical
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Registry readers
# ─────────────────────────────────────────────────────────────────────────────


def spec_from_registry(
    name: str, skill_cfg: dict, *, source: Optional[Path] = None
) -> McpServerSpec:
    """The expanded reader. `command` defaults to `"python3"` on a stdio
    block with no `command` — the behaviour `mcp_sync.py` and
    `hub.build_remote_desired_state` have had since before this wave (M3);
    `validate_mcp_entry` reports that case as a WARNING, never an error.

    When `source` is given, every `"{source}"` occurrence in `args` is
    replaced with `str(source)`. No source lookup is performed here — the
    caller resolves it (via `skill_meta.skill_source`) only when
    `skill_cfg["source"]` is truthy.
    """
    mcp = skill_cfg.get("mcp") or {}
    transport = _normalize_transport(mcp.get("transport")) or "stdio"

    raw_args = [a for a in (mcp.get("args") or [])]
    if source is not None:
        args = [
            a.replace("{source}", str(source)) if isinstance(a, str) else a
            for a in raw_args
        ]
    else:
        args = list(raw_args)

    command = mcp.get("command")
    if not command:
        command = "python3" if transport == "stdio" else ""

    timeout_ms = mcp.get("timeout_ms")
    if timeout_ms is not None:
        timeout_ms = int(timeout_ms)

    return McpServerSpec(
        name=name,
        command=command,
        args=args,
        env=dict(mcp.get("env") or {}),
        cwd=mcp.get("cwd"),
        transport=transport,
        url=mcp.get("url"),
        headers=dict(mcp.get("headers") or {}),
        timeout_ms=timeout_ms,
        allow_literal_secrets=bool(mcp.get("allow_literal_secrets", False)),
    )


def raw_spec_from_registry(name: str, skill_cfg: dict) -> McpServerSpec:
    """`spec_from_registry` with `source=None` — `{source}` left UNEXPANDED.

    The ONLY spec that may reach `canonical_spec_dict` (F1). Do not feed the
    result of `spec_from_registry(..., source=<a path>)` there.
    """
    return spec_from_registry(name, skill_cfg, source=None)


def spec_to_registry_block(spec: McpServerSpec, *, prior: Optional[dict] = None) -> dict:
    """The inverse of `spec_from_registry`: an `McpServerSpec` → an `mcp:`
    registry dict, omitting empty/default-valued fields for a clean write.

    `prior` is the previous `mcp:` block (if any); its legacy `runtime` key
    (read by nothing, per INTERFACES §2) is carried forward unconditionally
    so a scaffolded entry round-trips through `hub mcp set` unchanged.
    """
    block: dict = {}
    if spec.transport != "stdio":
        block["transport"] = spec.transport
    if spec.command:
        block["command"] = spec.command
    if spec.args:
        block["args"] = list(spec.args)
    if spec.env:
        block["env"] = dict(spec.env)
    if spec.cwd is not None:
        block["cwd"] = spec.cwd
    if spec.url is not None:
        block["url"] = spec.url
    if spec.headers:
        block["headers"] = dict(spec.headers)
    if spec.timeout_ms is not None:
        block["timeout_ms"] = spec.timeout_ms
    if spec.allow_literal_secrets:
        block["allow_literal_secrets"] = True
    if prior and "runtime" in prior:
        block["runtime"] = prior["runtime"]
    return block


# ─────────────────────────────────────────────────────────────────────────────
# Validation (never raises, never prints — `skill_meta.validate_registry_skills`
# and `hub mcp add|set` decide what to do with the result)
# ─────────────────────────────────────────────────────────────────────────────

_DEFAULT_FORM_RE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}")


def validate_mcp_entry(name: str, skill_cfg: dict) -> tuple[list[str], list[str]]:
    """`(errors, warnings)` for one `mcp-server` registry entry. Never raises.

    The error set is exactly four cases (plans/B.md M3): an unknown
    transport, `http`/`sse` with no `url`, `url` on a stdio block, `headers`
    on a stdio block. Everything else recoverable — including a stdio block
    with no `command` — is a warning.
    """
    errors: list[str] = []
    warnings: list[str] = []
    mcp = skill_cfg.get("mcp") if isinstance(skill_cfg, dict) else None
    if not isinstance(mcp, dict):
        mcp = {}

    transport = _normalize_transport(mcp.get("transport"))
    if transport is None:
        errors.append(f"{name}: unknown mcp transport '{mcp.get('transport')}'")
        return errors, warnings

    if transport in ("http", "sse"):
        if not mcp.get("url"):
            errors.append(f"{name}: transport '{transport}' requires 'url'")
    else:  # stdio
        if mcp.get("url"):
            errors.append(f"{name}: 'url' is not valid on a stdio transport")
        if mcp.get("headers"):
            errors.append(f"{name}: 'headers' is not valid on a stdio transport")
        if not mcp.get("command"):
            warnings.append(f"{name}: command absent — defaulting to python3")

    raw_headers = mcp.get("headers")
    headers: dict = raw_headers if isinstance(raw_headers, dict) else {}
    raw_env = mcp.get("env")
    env: dict = raw_env if isinstance(raw_env, dict) else {}

    for key in list(headers) + list(env):
        if ref_names(key):
            warnings.append(
                f"{name}: only Claude Code and Pi expand a reference in a key "
                f"('{key}')"
            )
    for value in list(headers.values()) + list(env.values()):
        if isinstance(value, str) and _DEFAULT_FORM_RE.search(value):
            warnings.append(
                f"{name}: the ':-default' form only reaches Claude Code and Pi"
            )

    return errors, warnings


# ─────────────────────────────────────────────────────────────────────────────
# The remote-connector wire dict (F1 — fed ONLY `raw_spec_from_registry`)
# ─────────────────────────────────────────────────────────────────────────────


def canonical_spec_dict(spec: McpServerSpec) -> dict:
    """The dict `skill_hub.infrastructure.connectors.hermes._canonical_mcp_bytes` hashes.

    stdio keeps `command`/`args`/`env` UNCONDITIONALLY (today's three keys —
    D3 "omit-if-default": every existing remote sha stays byte-identical),
    plus `cwd`/`timeout_ms` when set. A non-stdio spec omits those three and
    emits `transport`/`url` (+ `headers`/`timeout_ms` when non-empty) — it
    cannot collide with an existing sha because no such spec existed before
    this wave.
    """
    if spec.transport == "stdio":
        out: dict = {"command": spec.command, "args": list(spec.args), "env": dict(spec.env)}
        if spec.cwd is not None:
            out["cwd"] = spec.cwd
        if spec.timeout_ms is not None:
            out["timeout_ms"] = spec.timeout_ms
        return out
    out = {"transport": spec.transport, "url": spec.url}
    if spec.headers:
        out["headers"] = dict(spec.headers)
    if spec.timeout_ms is not None:
        out["timeout_ms"] = spec.timeout_ms
    return out


# ─────────────────────────────────────────────────────────────────────────────
# The `${VAR}` grammar
# ─────────────────────────────────────────────────────────────────────────────

#: `${VAR}` or `${VAR:-default}` — the one grammar every reader/writer shares.
_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}")

#: A value that IS, in full, exactly one `${VAR}` with no default suffix and
#: no surrounding text — the shape codex/opencode can represent directly.
_EXACT_REF_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")

#: A value that IS, in full, exactly one `${VAR:-default}` — the shape
#: codex/opencode can never represent (M4/m9).
_EXACT_DEFAULT_REF_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}$")

#: A value that IS, in full, exactly a bare shell/Windows-style reference
#: (`$NAME`, `%NAME%`) — a different (and more limited) grammar than `${…}`,
#: but still clearly a reference, not a literal (E3 rev 2 catalogue E06).
_SHELL_REF_RE = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]*$")
_PERCENT_REF_RE = re.compile(r"^%[A-Za-z_][A-Za-z0-9_]*%$")


def ref_names(value: object) -> list[str]:
    """The `${VAR}` names in `value`, in order, deduped. `[]` for anything
    that is not a string or carries no reference."""
    if not isinstance(value, str):
        return []
    out: list[str] = []
    for m in _REF_RE.finditer(value):
        n = m.group(1)
        if n not in out:
            out.append(n)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Name normalisation (E3 rev 2 §2.1/§2.2) — the one slugifier every door
# routes through, so "Sanity" refuses (or renames) identically everywhere.
# ─────────────────────────────────────────────────────────────────────────────

#: A private copy of `hub_core.SLUG_RE`'s pattern — `mcp_spec.py` stays a
#: stdlib leaf and cannot import `hub_core`. `tests/test_mcp_spec.py` pins
#: the two patterns byte-equal so they can never drift apart.
_SLUG_RE = re.compile(r"^[a-z0-9-]+$")

#: A raw name carrying any of these is refused outright — never derive a
#: filesystem path from separator debris (catalogue N10/N11).
_PATH_LIKE_RE = re.compile(r"[/\\\x00]")


def slugify_server_name(raw: object) -> Optional[str]:
    """NFKD-normalize, drop combining marks, lowercase, collapse every run of
    characters outside `[a-z0-9-]` to a single `-`, then strip leading and
    trailing `-`. Returns `None` (the caller's `invalid_name` signal) when:

    - `raw` is not a non-empty string,
    - the raw (untrimmed) name contains `/`, `\\`, or a NUL byte,
    - the trimmed name is a bare `.` or `..` segment,
    - or the result is empty or still fails the slug pattern.

    No length refusal — a name past 64 chars is accepted; the caller warns
    `name_long`. Never raises.
    """
    if not isinstance(raw, str) or raw == "":
        return None
    if _PATH_LIKE_RE.search(raw):
        return None
    stripped = raw.strip()
    if stripped == "" or stripped in (".", ".."):
        return None
    decomposed = unicodedata.normalize("NFKD", stripped)
    without_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    lowered = without_marks.lower()
    collapsed = re.sub(r"[^a-z0-9-]+", "-", lowered).strip("-")
    if not collapsed or not _SLUG_RE.match(collapsed):
        return None
    return collapsed


# ─────────────────────────────────────────────────────────────────────────────
# Literal-secret heuristic — patterns loaded from the shared corpus fixture
# (m9, m12): one source, compiled here AND (via the same JSON file) in
# `app/src/lib/mcpContract.ts`, so the two runtimes cannot silently drift.
# ─────────────────────────────────────────────────────────────────────────────

#: Identical to `tests/fixtures/mcp_secret_corpus.json`'s "patterns" block.
#: A packaged build ships no `tests/` directory — this is what it falls back
#: to. `tests/test_mcp_spec.py` asserts byte-for-byte equality with the
#: fixture so the two can never drift apart.
_FALLBACK_PATTERNS = {
    "key_re": (
        r"(?i)(^|[-_])(authorization|bearer)$|(api[-_]?key|token|secret|password|passwd"
        r"|cookie|set-cookie|x-auth-token|x-access-token|private-token)$"
    ),
    "value_re": r"(?i)^(bearer|token)\s+\S{8,}$",
    "prefixes": [
        "sk-",
        "sk_",
        "ghp_",
        "gho_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "AKIA",
        "glpat-",
        "AIza",
    ],
    "opaque_re": r"^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_\-]{20,}$",
}

_CORPUS_PATH = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "mcp_secret_corpus.json"


def _load_secret_patterns() -> dict:
    try:
        data = json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))
        patterns = data.get("patterns")
        if isinstance(patterns, dict) and {
            "key_re",
            "value_re",
            "prefixes",
            "opaque_re",
        } <= set(patterns):
            return patterns
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    return _FALLBACK_PATTERNS


_PATTERNS = _load_secret_patterns()
_KEY_RE = re.compile(_PATTERNS["key_re"])
_VALUE_RE = re.compile(_PATTERNS["value_re"])
_SECRET_PREFIXES: tuple[str, ...] = tuple(_PATTERNS["prefixes"])
_OPAQUE_RE = re.compile(_PATTERNS["opaque_re"])

#: A value that IS, in full, a recognized auth SCHEME with nothing (or only
#: whitespace) after it — `"Bearer "` carries no credential (catalogue H02).
#: N7: `bearer`/`basic` are real HTTP auth scheme words; `token` is NOT — a
#: value that is bare `"token"` is not "a scheme with nothing after it", it
#: is an ordinary (and, next to a key like `Authorization`, suspicious)
#: word, and §2.7's rule is narrower than the regex used to be.
_SCHEME_ONLY_RE = re.compile(r"(?i)^(bearer|basic)\s*$")


def looks_like_secret(key: str, value: object) -> bool:
    """True when `value` carries no `${…}` reference and looks like a
    credential — by key name (a suffix/exact-set rule), by value shape
    (`Bearer <token>`), by a known vendor prefix, or by looking sufficiently
    opaque (20+ mixed alnum characters).

    Never true for: an empty/falsy value, a value carrying a `${…}` ref, an
    exact bare reference (`$NAME`, `%NAME%` — catalogue E06), or a
    recognized auth scheme with nothing after it (catalogue H02).
    """
    if not isinstance(value, str) or not value:
        return False
    if "${" in value:
        return False
    if _SHELL_REF_RE.match(value) or _PERCENT_REF_RE.match(value):
        return False
    if _SCHEME_ONLY_RE.match(value):
        return False
    if isinstance(key, str) and _KEY_RE.search(key):
        return True
    if _VALUE_RE.match(value):
        return True
    if value.startswith(_SECRET_PREFIXES):
        return True
    if _OPAQUE_RE.match(value):
        return True
    return False


#: Placeholder a redacted URL segment is rewritten to (mirrors `mcp_reconcile`
#: and `backup.py`'s own `REDACTED`/`<redacted>` literals — kept private and
#: distinct from either so a caller of `redact_url_secrets` never has to
#: import this module just to compare against the sentinel).
_URL_REDACTED = "<redacted>"


def redact_url_secrets(url: object, *, flagged_params: Optional[set] = None) -> object:
    """Rewrite (a) a URL's USERINFO (`user:pw@` — a literal credential
    `secret_keys_in_spec` flags as `url.userinfo`), and (b) flagged
    query-string parameter VALUES, to `<redacted>`. `flagged_params` is the
    known set of query param names to redact; `None` means "decide per-param
    via `looks_like_secret`" — the blind path for a value with no spec at
    all (e.g. a server-returned resource URI, plans/G.md §5.11). Returns
    `url` unchanged if it is not a non-empty string or nothing in it is
    flagged.

    Promoted from `mcp_reconcile._redact_url` (plans/G.md §5.11): one
    implementation, three runtimes (`mcp_reconcile`, `backup.py`,
    `mcp_catalog`) — a credential in a URL is exactly as sensitive whether it
    reached this function from a discovered native entry, a registry
    snapshot bound for the backup repo, or a server's own catalogue.
    """
    if not isinstance(url, str) or url == "":
        return url
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    changed = False

    netloc = parts.netloc
    if parts.username or parts.password:
        try:
            host = parts.hostname or ""
            port = parts.port
        except ValueError:
            return url
        netloc = f"{host}:{port}" if port else host
        changed = True

    query = parts.query
    if query:
        pairs = parse_qsl(query, keep_blank_values=True)
        new_pairs = []
        query_changed = False
        for k, v in pairs:
            should_redact = k in flagged_params if flagged_params is not None else looks_like_secret(k, v)
            if should_redact:
                new_pairs.append((k, _URL_REDACTED))
                query_changed = True
            else:
                new_pairs.append((k, v))
        if query_changed:
            query = urlencode(new_pairs)
            changed = True

    if not changed:
        return url
    return urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))


def secret_keys_in_spec(spec: McpServerSpec) -> list[str]:
    """Every header key, env key, `url.query:<param>` token (m9), and
    `url.userinfo` (E3 rev 2 catalogue U01 — a URL carrying `user:pw@` or
    `user@`) whose value looks like a credential."""
    out: list[str] = []
    for key, value in spec.headers.items():
        if looks_like_secret(key, value):
            out.append(key)
    for key, value in spec.env.items():
        if looks_like_secret(key, value):
            out.append(key)
    if spec.url:
        from urllib.parse import parse_qsl, urlsplit

        parts = urlsplit(spec.url)
        if parts.username or parts.password:
            out.append("url.userinfo")
        for key, value in parse_qsl(parts.query, keep_blank_values=True):
            if looks_like_secret(key, value):
                out.append(f"url.query:{key}")
    return out


#: A leading auth scheme `suggest_ref` preserves verbatim (case-insensitive).
_AUTH_SCHEME_RE = re.compile(r"(?i)^(Bearer|Basic|Token)\s+")


def _upper_snake(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_")
    return cleaned.upper()


def suggest_ref(server_name: str, key: str, value: str) -> tuple[str, str]:
    """`(new_value, var_name)` — the `${VAR}` replacement `hub mcp add|set`
    offers for a literal secret (m5).

    Keeps a leading auth scheme (`Bearer `, `Basic `, `Token `) so a Codex
    `bearer_token_env_var` mapping still matches afterwards. The variable
    name is `<SERVER>_<KEY>` upper-snake — except an `Authorization` key
    becomes `TOKEN` (an env var literally named `AUTHORIZATION` reads as
    odd and Codex's own vocabulary already calls it a token).
    """
    m = _AUTH_SCHEME_RE.match(value or "")
    scheme = m.group(0) if m else ""
    key_part = "TOKEN" if key.strip().lower() == "authorization" else _upper_snake(key)
    var_name = _upper_snake(f"{server_name}_{key_part}")
    return f"{scheme}${{{var_name}}}", var_name


def to_native(spec: McpServerSpec, adapter_key: str) -> tuple[dict, list[str]]:
    """`(native_entry, skip_reasons)` for one harness adapter key
    (`"claude"` | `"codex"` | `"opencode"`). `pi` shares the `"claude"`
    mapping — there is no separate `pi` key."""
    from skill_hub.domain.harnesses.harness_adapter_api import McpNativeRequest, thaw_mcp_value
    from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_codec

    codec = bundled_codec(adapter_key)
    request = McpNativeRequest(
        name=spec.name,
        command=spec.command,
        args=tuple(spec.args),
        env=dict(spec.env),
        cwd=spec.cwd,
        transport=spec.transport,
        url=spec.url,
        headers=dict(spec.headers),
        timeout_ms=spec.timeout_ms,
        allow_literal_secrets=spec.allow_literal_secrets,
    )
    result = codec.encode(request)

    return thaw_mcp_value(result.native_entry), list(result.skip_reasons)


# ─────────────────────────────────────────────────────────────────────────────
# `normalize_native` — the reader behind `hub mcp add|set --json-stdin` (B2),
# `hub mcp reconcile` import (P1), and the New sheet's paste path — the ONE
# normaliser (E3 rev 2 §2.1). Never raises: every malformed shape becomes a
# closed-set `reason` word on the returned `NativeNormalization` instead of an
# exception. `parse_native` below is a thin exception-raising wrapper kept for
# every existing caller. `adapter_key` selects a bundled native decoder.
# ─────────────────────────────────────────────────────────────────────────────

def normalize_native(
    obj: object,
    *,
    name: str = "",
    adapter_key: str = "claude",
    decoder: Optional["McpNativeDecoder"] = None,
) -> NativeNormalization:
    """Decode one native MCP entry through the selected bundled decoder.

    The decoder owns native format recognition and the generic validation policy;
    this host boundary only restores the mutable ``McpServerSpec`` shape.
    """
    try:
        if decoder is None:
            from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_decoder

            decoder = bundled_decoder(adapter_key)
        result = decoder.decode(obj)
    except Exception:  # pragma: no cover - defensive totality boundary
        return NativeNormalization(None, "unknown_shape", [])
    if result.entry is None:
        return NativeNormalization(None, result.reason or "unknown_shape", list(result.warnings))
    entry = result.entry
    spec = McpServerSpec(
        name=name,
        command=entry.command,
        args=list(entry.args),
        env=dict(entry.env),
        cwd=entry.cwd,
        transport=entry.transport,
        url=entry.url,
        headers=dict(entry.headers),
        timeout_ms=entry.timeout_ms,
    )
    return NativeNormalization(spec, None, list(result.warnings))

def parse_native(
    obj: dict,
    *,
    name: Optional[str] = None,
    adapter_key: str = "claude",
    decoder: Optional["McpNativeDecoder"] = None,
) -> tuple[McpServerSpec, list[str]]:
    """Parse a single native server object (the `claude mcp add-json` shape)
    into an `McpServerSpec`. Raises `UnsupportedNativeEntry` for a shape hub
    cannot represent; never for anything merely unfamiliar (unknown keys are
    reported as warnings and dropped, never silently swallowed).

    A thin exception-raising wrapper over `normalize_native` (E3 rev 2) —
    kept so every pre-existing caller's signature and try/except still work
    unchanged."""
    result = normalize_native(
        obj, name=name or "", adapter_key=adapter_key, decoder=decoder
    )
    if result.spec is None:
        reason = result.reason or "unknown_shape"
        bare, _, detail = reason.partition(":")
        raise UnsupportedNativeEntry(bare, detail or None)
    return result.spec, result.warnings
