"""Bundled MCP native encoders.

The codecs are deliberately independent of ``mcp_spec``.  Host policy and
registry parsing stay in that module; this module only translates an immutable
SDK request into one native entry.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional
from urllib.parse import urlsplit

from skill_hub.domain.harnesses.harness_adapter_api import (
    McpDecodedEntry,
    McpNativeCodec,
    McpNativeDecoder,
    McpNativeDecodeResult,
    McpNativeRequest,
    McpNativeResult,
)

_EXACT_REF_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
_EXACT_DEFAULT_REF_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}$")
_SHELL_REF_RE = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]*$")
_PERCENT_REF_RE = re.compile(r"^%[A-Za-z_][A-Za-z0-9_]*%$")
_ENV_KEY_USUAL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TRANSPORTS = ("stdio", "http", "sse")
_TRANSPORT_ALIASES = {"streamable-http": "http"}
_OAUTH_KEYS = {"oauth", "oauthConfig", "oauth_config", "authorization_server", "authorizationServer"}
_KNOWN_KEYS = {
    "command", "args", "env", "cwd", "type", "url", "headers", "timeout",
    "enabled", "disabled", "startup_timeout_sec", "tool_timeout_sec",
}
_BOUNDED_DETAIL_LIMIT = 40


def _bounded_detail(value: object, limit: int = _BOUNDED_DETAIL_LIMIT) -> str:
    text = value if isinstance(value, str) else type(value).__name__
    text = "".join(ch if ch.isprintable() else "�" for ch in text)
    if len(text) > limit:
        text = text[: max(limit - 1, 0)] + "…"
    return text


def _match_transport_word(raw: str) -> Optional[str]:
    if raw in _TRANSPORTS:
        return raw
    if raw in _TRANSPORT_ALIASES:
        return _TRANSPORT_ALIASES[raw]
    low = raw.lower()
    if low in _TRANSPORTS:
        return low
    if low in _TRANSPORT_ALIASES:
        return _TRANSPORT_ALIASES[low]
    return None


def _coerce_timeout_ms(raw: object) -> tuple[Optional[int], bool, bool]:
    if isinstance(raw, bool):
        return None, False, True
    if isinstance(raw, (int, float)):
        if raw < 0:
            return None, False, True
        return int(raw), False, False
    if isinstance(raw, str):
        try:
            value = float(raw)
        except ValueError:
            return None, False, True
        if value < 0:
            return None, False, True
        return int(value), True, False
    return None, False, True


def _refuse(reason: str) -> McpNativeDecodeResult:
    return McpNativeDecodeResult(reason=reason)


def _decode_generic(obj: dict) -> McpNativeDecodeResult:
    """Apply the one generic native-shape algorithm used by all decoders."""
    warnings: list[str] = []
    if obj.get("enabled") is False or obj.get("disabled") is True:
        return _refuse("disabled_upstream")
    if _OAUTH_KEYS & set(obj):
        return _refuse("oauth_block")

    raw_type = obj.get("type")
    has_command = "command" in obj and obj.get("command") not in (None, "")
    has_url = "url" in obj and obj.get("url") is not None
    if raw_type is not None:
        if not isinstance(raw_type, str):
            return _refuse("malformed_field:type")
        if raw_type.strip().lower() == "ws":
            return _refuse("ws_transport")
        transport = _match_transport_word(raw_type)
        if transport is None:
            return _refuse(f"unknown_transport:{_bounded_detail(raw_type)}")
        if raw_type != transport and raw_type not in _TRANSPORT_ALIASES:
            warnings.append(f"transport_alias:{_bounded_detail(raw_type)}")
    elif has_command and has_url:
        return _refuse("transport_conflict")
    elif has_command:
        transport = "stdio"
    elif has_url:
        transport = "http"
    else:
        return _refuse("unknown_shape")

    raw_headers = obj.get("headers")
    if transport == "stdio":
        if has_url or raw_headers is not None:
            return _refuse("transport_conflict")
    else:
        if has_command:
            return _refuse("transport_conflict")
        if not has_url:
            return _refuse("no_endpoint")

    headers: dict[str, str] = {}
    if transport != "stdio" and raw_headers is not None:
        if not isinstance(raw_headers, dict) or not all(isinstance(v, str) for v in raw_headers.values()):
            return _refuse("headers_helper")
        seen_lower: set[str] = set()
        for key, value in raw_headers.items():
            if not isinstance(key, str) or key == "":
                return _refuse("malformed_field:headers")
            lowered = key.lower()
            if lowered in seen_lower:
                return _refuse(f"duplicate_header:{_bounded_detail(lowered)}")
            seen_lower.add(lowered)
            if "\r" in value or "\n" in value:
                return _refuse("malformed_field:headers")
            headers[key] = value

    command = ""
    list_split_args: Optional[list[str]] = None
    if transport == "stdio":
        raw_command = obj.get("command")
        if raw_command in (None, ""):
            command = ""
        elif isinstance(raw_command, str):
            command = raw_command
            if re.search(r"\s", raw_command.strip()):
                warnings.append("command_has_arguments")
        elif isinstance(raw_command, list):
            if not raw_command or not all(isinstance(item, str) for item in raw_command):
                return _refuse("malformed_field:command")
            command = raw_command[0]
            list_split_args = list(raw_command[1:])
            warnings.append("command_list_split")
        else:
            return _refuse("malformed_field:command")

    raw_args = obj.get("args")
    if raw_args is None:
        args: list[str] = []
    elif isinstance(raw_args, list):
        if not all(isinstance(item, str) for item in raw_args):
            return _refuse("malformed_field:args")
        args = list(raw_args)
    else:
        return _refuse("malformed_field:args")
    if list_split_args is not None:
        args = list_split_args + args
    if any("{source}" in item for item in args):
        warnings.append("source_placeholder")
    if transport == "stdio" and not command:
        command = "python3"

    cwd = obj.get("cwd")
    if cwd is not None:
        if not isinstance(cwd, str):
            return _refuse("malformed_field:cwd")
        if not cwd.startswith("/"):
            warnings.append("cwd_not_absolute")

    env: dict[str, str] = {}
    raw_env = obj.get("env")
    if raw_env is not None:
        if not isinstance(raw_env, dict):
            return _refuse("malformed_field:env")
        for key, value in raw_env.items():
            if not isinstance(key, str) or key == "":
                return _refuse("malformed_field:env")
            if isinstance(value, (dict, list)):
                return _refuse("malformed_field:env")
            if not _ENV_KEY_USUAL_RE.match(key) and "${" not in key:
                warnings.append(f"env_key_unusual:{_bounded_detail(key)}")
            if isinstance(value, str):
                if _SHELL_REF_RE.match(value) or _PERCENT_REF_RE.match(value):
                    warnings.append(f"unexpanded_ref:{_bounded_detail(value)}")
                env[key] = value
            else:
                env[key] = json.dumps(value)
                warnings.append(f"env_value_coerced:{_bounded_detail(key)}")

    url: Optional[str] = None
    if transport != "stdio":
        raw_url = obj.get("url")
        if not isinstance(raw_url, str) or raw_url == "":
            return _refuse("malformed_url")
        try:
            parsed = urlsplit(raw_url)
        except ValueError:
            # Legacy totality wrapper classified parser exceptions separately.
            return _refuse("unknown_shape")
        scheme = parsed.scheme.lower()
        if not scheme:
            return _refuse("malformed_url")
        if scheme not in ("http", "https"):
            return _refuse(f"unsupported_url_scheme:{_bounded_detail(scheme)}")
        if not parsed.hostname:
            return _refuse("malformed_url")
        try:
            parsed.netloc.encode("ascii")
        except UnicodeEncodeError:
            warnings.append("non_ascii_host")
        if "${" in raw_url:
            warnings.append("ref_in_url")
        url = raw_url

    timeout_ms: Optional[int] = None
    raw_timeout = obj.get("timeout")
    if raw_timeout is not None:
        timeout_ms, was_coerced, is_error = _coerce_timeout_ms(raw_timeout)
        if is_error:
            return _refuse("malformed_field:timeout")
        if was_coerced:
            warnings.append("timeout_coerced")
    startup = obj.get("startup_timeout_sec")
    tool = obj.get("tool_timeout_sec")
    startup_num = startup if isinstance(startup, (int, float)) and not isinstance(startup, bool) else None
    tool_num = tool if isinstance(tool, (int, float)) and not isinstance(tool, bool) else None
    if startup_num is not None or tool_num is not None:
        chosen = tool_num if tool_num is not None else startup_num
        assert chosen is not None
        if timeout_ms is None:
            timeout_ms = int(chosen * 1000)
        if startup_num is not None and tool_num is not None and startup_num != tool_num:
            warnings.append("timeout_merged")

    for key in sorted(set(obj) - _KNOWN_KEYS - _OAUTH_KEYS):
        warnings.append(f"dropped_field:{_bounded_detail(key)}")
    return McpNativeDecodeResult(
        entry=McpDecodedEntry(command, tuple(args), env, cwd, transport, url, headers, timeout_ms),
        warnings=tuple(warnings),
    )


def _ceil_seconds(timeout_ms: int) -> int:
    return -(-timeout_ms // 1000)


class _ClaudeCodec:
    def encode(self, request: McpNativeRequest) -> McpNativeResult:
        if request.transport == "stdio":
            entry: dict[str, Any] = {
                "command": request.command,
                "args": list(request.args),
                "env": dict(request.env),
            }
            if request.cwd is not None:
                entry["cwd"] = request.cwd
            if request.timeout_ms is not None:
                entry["timeout"] = request.timeout_ms
            return McpNativeResult(entry)
        entry = {"type": request.transport, "url": request.url}
        if request.headers:
            entry["headers"] = dict(request.headers)
        if request.timeout_ms is not None:
            entry["timeout"] = request.timeout_ms
        return McpNativeResult(entry)


_BEARER_HEADER_RE = re.compile(r"^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def _codex_headers(headers: Mapping[str, str]) -> tuple[Optional[str], dict[str, str], dict[str, str], list[str]]:
    skips: list[str] = []
    working = dict(headers)
    bearer_var: Optional[str] = None
    for key in list(working):
        if key.lower() == "authorization":
            value = working[key]
            match = _BEARER_HEADER_RE.match(value) if isinstance(value, str) else None
            if match:
                bearer_var = match.group(1)
                del working[key]
            break
    env_http_headers: dict[str, str] = {}
    http_headers: dict[str, str] = {}
    for key, value in working.items():
        if not isinstance(value, str):
            skips.append(f"codex_header_not_representable:{key}")
            continue
        exact = _EXACT_REF_RE.match(value)
        if exact:
            env_http_headers[key] = exact.group(1)
            continue
        if not _ref_names(value):
            http_headers[key] = value
            continue
        skips.append(f"codex_header_not_representable:{key}")
    return bearer_var, env_http_headers, http_headers, skips


def _ref_names(value: str) -> list[str]:
    return re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}", value)


def _codex_stdio_env(env: Mapping[str, str]) -> tuple[dict[str, str], list[str], list[str]]:
    env_out: dict[str, str] = {}
    env_vars: list[str] = []
    skips: list[str] = []
    for key, value in env.items():
        if isinstance(value, str):
            exact = _EXACT_REF_RE.match(value)
            if exact:
                ref_var = exact.group(1)
                if ref_var == key:
                    env_vars.append(key)
                else:
                    skips.append(f"codex_env_not_representable:{key}")
                continue
            if _ref_names(value):
                skips.append(f"codex_env_not_representable:{key}")
                continue
        env_out[key] = value
    return env_out, sorted(env_vars), skips


class _CodexCodec:
    def encode(self, request: McpNativeRequest) -> McpNativeResult:
        if request.transport == "sse":
            return McpNativeResult({}, ("codex_no_sse",))
        if request.transport == "stdio":
            env_out, env_vars, skips = _codex_stdio_env(request.env)
            table: dict[str, Any] = {"command": request.command, "args": list(request.args), "env": env_out}
            if request.cwd is not None:
                table["cwd"] = request.cwd
            if env_vars:
                table["env_vars"] = env_vars
            if request.timeout_ms is not None:
                table["startup_timeout_sec"] = _ceil_seconds(request.timeout_ms)
            return McpNativeResult(table, tuple(skips))
        table = {"url": request.url}
        bearer_var, env_http_headers, http_headers, skips = _codex_headers(request.headers)
        if bearer_var is not None:
            table["bearer_token_env_var"] = bearer_var
        if env_http_headers:
            table["env_http_headers"] = env_http_headers
        if http_headers:
            table["http_headers"] = http_headers
        if request.timeout_ms is not None:
            seconds = _ceil_seconds(request.timeout_ms)
            table["tool_timeout_sec"] = seconds
            table["startup_timeout_sec"] = seconds
        return McpNativeResult(table, tuple(skips))


def _opencode_map(mapping: Mapping[str, str], *, reason: str) -> tuple[dict[str, str], list[str]]:
    output: dict[str, str] = {}
    skips: list[str] = []
    for key, value in mapping.items():
        exact = _EXACT_REF_RE.match(value) if isinstance(value, str) else None
        if exact:
            output[key] = "{env:%s}" % exact.group(1)
            continue
        if isinstance(value, str) and _EXACT_DEFAULT_REF_RE.match(value):
            skips.append(f"{reason}:{key}")
            continue
        output[key] = value
    return output, skips


class _OpenCodeCodec:
    def encode(self, request: McpNativeRequest) -> McpNativeResult:
        if request.transport == "stdio":
            entry: dict[str, Any] = {"type": "local", "command": [request.command, *request.args], "enabled": True}
            env_out, skips = _opencode_map(request.env, reason="opencode_default_dropped")
            if env_out:
                entry["environment"] = env_out
            if request.timeout_ms is not None:
                entry["timeout"] = request.timeout_ms
            return McpNativeResult(entry, tuple(skips))
        entry = {"type": "remote", "url": request.url, "enabled": True}
        headers_out, skips = _opencode_map(request.headers, reason="opencode_default_dropped")
        if headers_out:
            entry["headers"] = headers_out
        if request.timeout_ms is not None:
            entry["timeout"] = request.timeout_ms
        return McpNativeResult(entry, tuple(skips))


_BUNDLED_CODECS: Mapping[str, McpNativeCodec] = {
    "claude": _ClaudeCodec(),
    "codex": _CodexCodec(),
    "opencode": _OpenCodeCodec(),
}


def bundled_codec(adapter_key: str) -> McpNativeCodec:
    try:
        return _BUNDLED_CODECS[adapter_key]
    except KeyError as exc:
        raise ValueError(f"unknown MCP adapter key: {adapter_key!r}") from exc


def encode_native(request: McpNativeRequest, adapter_key: str) -> McpNativeResult:
    return bundled_codec(adapter_key).encode(request)


class _ClaudeDecoder:
    def decode(self, native: object) -> McpNativeDecodeResult:
        if not isinstance(native, dict):
            return _refuse("unknown_shape")
        if "headersHelper" in native:
            return _refuse("headers_helper")
        return _decode_generic(native)


def _codex_oauth_block(native: dict) -> bool:
    return native.get("auth") == "oauth" or isinstance(native.get("oauth"), dict)


class _CodexDecoder:
    def decode(self, native: object) -> McpNativeDecodeResult:
        if not isinstance(native, dict):
            return _refuse("unknown_shape")
        if _codex_oauth_block(native):
            return _refuse("oauth_block")
        if "http_headers_helper" in native:
            return _refuse("headers_helper")

        if native.get("url"):
            generic: dict[str, object] = {"type": "http", "url": native["url"]}
            headers: dict = {}
            for key in ("http_headers", "env_http_headers"):
                mapping = native.get(key)
                if mapping is not None and not isinstance(mapping, dict):
                    return _refuse("headers_helper")
            for key, value in (native.get("http_headers") or {}).items():
                if isinstance(value, str):
                    headers[key] = value
            for key, variable in (native.get("env_http_headers") or {}).items():
                if isinstance(variable, str):
                    headers[key] = f"${{{variable}}}"
            bearer_var = native.get("bearer_token_env_var")
            if isinstance(bearer_var, str) and bearer_var:
                headers["Authorization"] = f"Bearer ${{{bearer_var}}}"
            if headers:
                generic["headers"] = headers
            for key in ("startup_timeout_sec", "tool_timeout_sec"):
                if isinstance(native.get(key), (int, float)):
                    generic[key] = native[key]
            if "enabled" in native:
                generic["enabled"] = native["enabled"]
            return _decode_generic(generic)

        if native.get("command"):
            raw_args = native.get("args")
            raw_env = native.get("env")
            if raw_args is not None and not isinstance(raw_args, (list, tuple, str)):
                return _refuse("malformed_field:args")
            if raw_env is not None and not isinstance(raw_env, dict):
                return _refuse("malformed_field:env")
            env = dict(raw_env or {})
            generic_stdio: dict[str, object] = {
                "command": native["command"],
                "args": list(raw_args or []),
                "env": env,
            }
            for key in native.get("env_vars") or []:
                if isinstance(key, str):
                    env[key] = f"${{{key}}}"
            if native.get("cwd") is not None:
                generic_stdio["cwd"] = native["cwd"]
            for key in ("startup_timeout_sec", "tool_timeout_sec"):
                if isinstance(native.get(key), (int, float)):
                    generic_stdio[key] = native[key]
            if "enabled" in native:
                generic_stdio["enabled"] = native["enabled"]
            return _decode_generic(generic_stdio)
        return _refuse("unknown_shape")


def _reverse_opencode_map(mapping: object) -> dict:
    if not isinstance(mapping, dict):
        return {}
    return {
        key: (
            "${" + value[len("{env:") : -1] + "}"
            if isinstance(value, str)
            and value.startswith("{env:")
            and value.endswith("}")
            else value
        )
        for key, value in mapping.items()
    }


class _OpenCodeDecoder:
    def decode(self, native: object) -> McpNativeDecodeResult:
        if not isinstance(native, dict):
            return _refuse("unknown_shape")
        if "oauth" in native:
            return _refuse("oauth_block")
        if native.get("type") == "local":
            command = native.get("command")
            if isinstance(command, str) and command:
                command_list = [command]
            elif isinstance(command, list) and command:
                command_list = command
            else:
                return _refuse("unknown_shape")
            generic: dict[str, object] = {
                "command": command_list[0],
                "args": list(command_list[1:]),
                "env": _reverse_opencode_map(native.get("environment")),
            }
            if native.get("timeout") is not None:
                generic["timeout"] = native["timeout"]
            if "enabled" in native:
                generic["enabled"] = native["enabled"]
            return _decode_generic(generic)
        if native.get("type") == "remote":
            if not native.get("url"):
                return _refuse("no_endpoint")
            generic = {
                "type": "http",
                "url": native["url"],
                "headers": _reverse_opencode_map(native.get("headers")),
            }
            if native.get("timeout") is not None:
                generic["timeout"] = native["timeout"]
            if "enabled" in native:
                generic["enabled"] = native["enabled"]
            return _decode_generic(generic)
        return _refuse("unknown_shape")


_BUNDLED_DECODERS: Mapping[str, McpNativeDecoder] = {
    "claude": _ClaudeDecoder(),
    "codex": _CodexDecoder(),
    "opencode": _OpenCodeDecoder(),
}


def bundled_decoder(adapter_key: str) -> McpNativeDecoder:
    try:
        return _BUNDLED_DECODERS[adapter_key]
    except KeyError as exc:
        raise ValueError(f"unknown MCP decoder key: {adapter_key!r}") from exc


def decode_native(native: object, adapter_key: str) -> McpNativeDecodeResult:
    # Keep the public decoder total for malformed JSON-shaped input. Unknown
    # keys remain programmer errors and are deliberately raised above.
    decoder = bundled_decoder(adapter_key)
    try:
        return decoder.decode(native)
    except Exception:
        return _refuse("unknown_shape")
