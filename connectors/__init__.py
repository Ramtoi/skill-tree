"""Compatibility namespace for installed connector plugins.

Forward legacy imports to the relocated modules without loading a second
registry, discovery state, or set of contract classes.
"""

import importlib
import importlib.abc
import importlib.util
import sys

from skill_hub.infrastructure import connectors as _connectors


class _AliasLoader(importlib.abc.Loader):
    def __init__(self, target):
        self.target = target

    def create_module(self, spec):
        module = importlib.import_module(self.target)
        self.original_spec = module.__spec__
        return module

    def exec_module(self, module):
        # Import machinery assigns the alias spec to the shared module. Keep
        # its canonical name for reload, introspection, and multiprocessing.
        module.__spec__ = self.original_spec


class _AliasFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if not fullname.startswith("connectors."):
            return None
        canonical = "skill_hub.infrastructure." + fullname
        spec = importlib.util.find_spec(canonical)
        if spec is None:
            return None
        return importlib.util.spec_from_loader(
            fullname, _AliasLoader(canonical),
            is_package=spec.submodule_search_locations is not None,
        )


sys.meta_path.insert(0, _AliasFinder())
sys.modules[__name__] = _connectors
