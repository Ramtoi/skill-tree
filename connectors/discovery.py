"""Runtime discovery + registration of connector plugins.

`connectors/__init__.py` used to register connectors at package-import time via
two hardcoded imports (`from .hermes import HermesConnector` + a guarded
`import connectors_private`). That made importing the package non-trivial
(it pulled Hermes) and left distribution un-pluggable.

This module moves registration behind a **lazy, memoized** `ensure_discovered()`
that runs at most once per process, on first registry use (`get_connector` /
`all_connectors`), NOT at package import. It discovers connectors from, in
order (earlier sources win — a later source can never shadow an already-taken
key):

    1. builtin       — `connectors.hermes.HermesConnector`
    2. private       — `import connectors_private` (back-compat; absent in the
                       public build → tolerated)
    3. entry-point   — distributions exposing `skill_hub.connectors` entry points
    4. drop-in       — `*.py` files and `*/__init__.py` packages under
                       `data_home()/connectors/`

Every plugin loads inside its own try/except: a syntax error, a missing dep, or
a duplicate-key `ValueError` (the non-shadowing mechanism) logs ONE warning
naming the plugin and is skipped. `ensure_discovered()` itself never raises.

The `source` of each registered key is tracked (`connector_source`) so the
catalog can report builtin / private / entry-point / drop-in.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import inspect
import logging
import sys
import threading

import connectors  # fully initialized before this module is ever imported (lazy)

_LOG = logging.getLogger("skill_hub.connectors")

#: Runs at most once per process (D3). Reset via `_reset_for_tests`.
_discovered: bool = False

#: Guards concurrent first use; RLock so a plugin that re-enters the registry
#: during its own import doesn't deadlock (it hits `_in_progress` instead).
_LOCK = threading.RLock()
_in_progress: bool = False

#: registry key → discovery source ("builtin" | "private" | "entry-point" | "drop-in").
_SOURCE: dict[str, str] = {}

#: Entry-point group a distribution advertises a connector under.
ENTRY_POINT_GROUP = "skill_hub.connectors"


# ─────────────────────────────────────────────────────────────────────────────
# Public surface
# ─────────────────────────────────────────────────────────────────────────────


def ensure_discovered() -> None:
    """Discover + register all connector plugins exactly once. Never raises.

    Thread-safe: a concurrent caller blocks on the lock until discovery has
    fully finished, so it can never observe a half-populated registry. A
    same-thread re-entrant call (a plugin touching the registry during its own
    import) sees `_in_progress` and returns immediately instead of recursing.
    The `_discovered` flag is only published AFTER all phases completed.
    """
    global _discovered, _in_progress
    if _discovered:
        return
    with _LOCK:
        if _discovered or _in_progress:
            return
        _in_progress = True
        try:
            _discover_builtin()
            _discover_private()
            _discover_entry_points()
            _discover_dropins()
        finally:
            _in_progress = False
            _discovered = True


def connector_source(key: str) -> str:
    """Discovery source for a registered key (defaults to "builtin")."""
    return _SOURCE.get(key, "builtin")


def _reset_for_tests() -> None:
    """Reset discovery state so tests can re-run it against a fresh data home.

    Mirrors how `hub._DATA_HOME_CACHE` is reset in conftest. Clears the registry,
    the source map, and the memo flag, and evicts `connectors_private` from the
    module cache so its `_register_all()` re-runs on the next discovery pass
    (its registrations only happen at import time).
    """
    global _discovered, _in_progress
    _discovered = False
    _in_progress = False
    _SOURCE.clear()
    connectors.REMOTE_CONNECTORS.clear()
    sys.modules.pop("connectors_private", None)


# ─────────────────────────────────────────────────────────────────────────────
# Phases
# ─────────────────────────────────────────────────────────────────────────────


def _discover_builtin() -> None:
    before = set(connectors.REMOTE_CONNECTORS)
    try:
        if "hermes" not in connectors.REMOTE_CONNECTORS:
            from .hermes import HermesConnector

            connectors.register_connector(HermesConnector())
        _SOURCE.setdefault("hermes", "builtin")
    except Exception as exc:  # pragma: no cover - hermes import is guarded/lazy
        _warn("builtin:hermes", exc)
    _label_new(before, "builtin")


def _discover_private() -> None:
    before = set(connectors.REMOTE_CONNECTORS)
    try:
        import connectors_private  # noqa: F401 — self-registers on import
    except ModuleNotFoundError as exc:
        # The public build ships WITHOUT this dir — its absence is expected.
        if exc.name != "connectors_private":
            _warn("connectors_private", exc)
    except Exception as exc:
        _warn("connectors_private", exc)
    _label_new(before, "private")


def _discover_entry_points() -> None:
    try:
        eps = importlib.metadata.entry_points()
    except Exception as exc:  # pragma: no cover - importlib.metadata failure
        _warn("entry-points", exc)
        return
    for ep in _select_entry_points(eps, ENTRY_POINT_GROUP):
        before = set(connectors.REMOTE_CONNECTORS)
        name = getattr(ep, "name", "?")
        try:
            obj = ep.load()
            _register_object(obj)
        except Exception as exc:
            _warn(f"entry-point:{name}", exc)
        _label_new(before, "entry-point")


def _discover_dropins() -> None:
    try:
        import hub  # local import to avoid an import cycle at module load

        root = hub.data_home() / "connectors"
    except Exception as exc:  # pragma: no cover - data_home resolution failure
        _warn("drop-in:data_home", exc)
        return
    try:
        if not root.is_dir():
            return
        entries = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError as exc:  # unreadable dir must not break the never-raises contract
        _warn("drop-in:scan", exc)
        return
    for entry in entries:
        name = entry.name
        if name.startswith((".", "_")):
            continue
        if entry.is_dir():
            init = entry / "__init__.py"
            if init.is_file():
                _load_dropin(name, init, is_package=True)
        elif entry.suffix == ".py":
            _load_dropin(name[:-3], entry, is_package=False)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _select_entry_points(eps, group: str):
    """Return the entry points in `group`, across importlib.metadata versions."""
    # Python 3.10+ EntryPoints.select
    select = getattr(eps, "select", None)
    if callable(select):
        try:
            return list(select(group=group))
        except Exception:  # pragma: no cover - defensive
            pass
    # Python 3.9 dict-shaped result
    get = getattr(eps, "get", None)
    if callable(get):
        return list(get(group, []))
    # Plain iterable of EntryPoint objects
    return [ep for ep in eps if getattr(ep, "group", None) == group]


def _register_object(obj) -> None:
    """Register a loaded entry-point object.

    A `RemoteConnector` subclass is instantiated + registered; an instance is
    registered directly; a module is assumed to have self-registered on import
    (nothing more to do).
    """
    from .base import RemoteConnector

    if inspect.isclass(obj) and issubclass(obj, RemoteConnector):
        connectors.register_connector(obj())
    elif isinstance(obj, RemoteConnector):
        connectors.register_connector(obj)
    # else: a module (self-registered) or an unrelated object — no-op.


def _load_dropin(modname: str, path, *, is_package: bool) -> None:
    """Import one drop-in file/package under a namespaced module name."""
    before = set(connectors.REMOTE_CONNECTORS)
    mod_name = f"skill_hub_dropin_{modname}"
    try:
        if is_package:
            spec = importlib.util.spec_from_file_location(
                mod_name,
                str(path),
                submodule_search_locations=[str(path.parent)],
            )
        else:
            spec = importlib.util.spec_from_file_location(mod_name, str(path))
        if spec is None or spec.loader is None:
            raise ImportError(f"could not create import spec for {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        spec.loader.exec_module(module)  # self-registers on import
        _register_module_connectors(module)
    except Exception as exc:
        sys.modules.pop(mod_name, None)
        _warn(f"drop-in:{modname}", exc)
    _label_new(before, "drop-in")


def _register_module_connectors(module) -> None:
    """Register any RemoteConnector subclasses a drop-in *defines* but did not
    self-register — belt-and-suspenders so a plugin author can either call
    `register_connector` themselves or just export the class."""
    from .base import RemoteConnector

    for obj in vars(module).values():
        if (
            inspect.isclass(obj)
            and issubclass(obj, RemoteConnector)
            and obj is not RemoteConnector
            and getattr(obj, "key", "")
            and obj.__module__ == module.__name__
            and obj.key not in connectors.REMOTE_CONNECTORS
        ):
            connectors.register_connector(obj())


def _label_new(before: set, source: str) -> None:
    for key in connectors.REMOTE_CONNECTORS:
        if key not in before:
            _SOURCE.setdefault(key, source)


def _warn(plugin: str, exc: Exception) -> None:
    _LOG.warning(
        "skill-hub: connector plugin %r failed to load and was skipped: %s: %s",
        plugin,
        exc.__class__.__name__,
        exc,
    )
