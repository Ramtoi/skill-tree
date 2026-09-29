"""`hub integration` — offline validation, runtime inventory, and reports."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from skill_hub import hub_core

NAME = "integration"

_HARNESS_IDS = ("claude-code", "codex", "pi", "opencode")

p_integration = None


def _add_selection(parser: Any, *, allow_invalid_profile: bool = False) -> None:
    parser.add_argument("--repo-root", dest="repo_root", type=Path)
    parser.add_argument("--catalog", dest="catalog", type=Path)
    profile_kwargs: dict[str, Any] = {"default": "offline"}
    if not allow_invalid_profile:
        profile_kwargs["choices"] = ("quick", "offline")
    parser.add_argument("--profile", **profile_kwargs)
    parser.add_argument("--harness", dest="harness", action="append", default=[])
    parser.add_argument("--feature", dest="feature", action="append", default=[])
    parser.add_argument("--case", dest="case", action="append", default=[])


def register(sub: Any) -> None:
    global p_integration
    p_integration = sub.add_parser("integration", help="Validate offline contracts and inspect runtime inventory")
    integration_sub = p_integration.add_subparsers(dest="integration_cmd")

    listing = integration_sub.add_parser("list", help="List audited integration cases")
    _add_selection(listing)
    listing.add_argument("--json", action="store_true", required=True, help="Emit JSON")

    validate = integration_sub.add_parser("validate", help="Run selected offline integration cases")
    _add_selection(validate, allow_invalid_profile=True)
    validate.add_argument("--report-dir", dest="report_dir", required=True, type=Path)
    validate.add_argument("--json", action="store_true", help="Emit the completed report as JSON")

    native = integration_sub.add_parser("native", help="Run one explicitly authorized native recipe")
    native.add_argument("--recipe", required=True)
    native.add_argument("--authorize-native", action="store_true")
    native.add_argument("--repo-root", dest="repo_root", type=Path)
    native.add_argument("--catalog", dest="catalog", type=Path)
    native.add_argument("--report-dir", dest="report_dir", required=True, type=Path)
    native.add_argument("--json", action="store_true", help="Emit the completed report as JSON")

    inventory_parser = integration_sub.add_parser("inventory", help="Inspect cached or refreshed runtime identities")
    inventory_parser.add_argument("--refresh", action="store_true")
    inventory_parser.add_argument("--harness", dest="harness", action="append", default=[])
    inventory_parser.add_argument("--json", action="store_true", help="Emit JSON")

    report = integration_sub.add_parser("report", help="Read an existing validation report")
    report.add_argument("path", type=Path)
    report.add_argument("--compare", type=Path, help="Compare this report with a prior report")
    report.add_argument("--json", action="store_true", help="Emit JSON")


def _error(message: str, json_out: bool, *, json_read: bool = False) -> int:
    payload = {"status": "error", "errors": [message]}
    if json_out:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print("hub integration: " + message)
    return 0 if json_out and json_read else 2


def _validate_harnesses(values: Iterable[str]) -> Optional[str]:
    unknown = sorted(set(values) - set(_HARNESS_IDS))
    return "unknown harness selector(s): " + ", ".join(unknown) if unknown else None


def _checkout_root(args: Any) -> Path:
    if args.repo_root is not None:
        return args.repo_root.resolve()
    from skill_hub.infrastructure.harnesses import harness_validation

    return harness_validation.REPO_ROOT


def _catalog_args(args: Any) -> list[str]:
    values = ["list", "--repo-root", str(_checkout_root(args))]
    if args.catalog is not None:
        values.extend(("--catalog", str(args.catalog)))
    values.extend(("--profile", args.profile))
    for option, entries in (("--harness", args.harness), ("--feature", args.feature), ("--case", args.case)):
        for entry in entries:
            values.extend((option, entry))
    return values


def _list(args: Any) -> int:
    from skill_hub.infrastructure.harnesses import harness_validation

    error = _validate_harnesses(args.harness)
    if error:
        return _error(error, True, json_read=True)
    try:
        catalog = harness_validation.load_catalog(args.catalog, _checkout_root(args))
        selected = harness_validation._select_cases(
            catalog, args.profile, args.harness, args.feature, args.case
        )
    except (harness_validation.CatalogError, OSError, ValueError) as exc:
        return _error(str(exc), True, json_read=True)
    print(json.dumps(selected, indent=2, sort_keys=True))
    return 0


def _validate(args: Any) -> int:
    from skill_hub.infrastructure.harnesses import harness_validation

    runner_args = _catalog_args(args)
    runner_args[0] = "run"
    runner_args.extend(("--report-dir", str(args.report_dir)))
    # Let the root runner allocate a durable selection-error report for an
    # unknown harness instead of constructing a cache request for it here.
    provenance = {"status": "not_collected"} if _validate_harnesses(args.harness) else _provenance_data(args)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = harness_validation.main(runner_args, data=provenance)
    lines = [line.strip() for line in output.getvalue().splitlines() if line.strip()]
    report_path = Path(lines[-1]) if lines and Path(lines[-1]).is_dir() else None
    if report_path is None or not (report_path / "report.json").is_file():
        return _error("validation did not produce a report", args.json)
    try:
        payload = json.loads((report_path / "report.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return _error("cannot read validation report: {}".format(exc), args.json)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(str(report_path))
    return code


def _native(args: Any) -> int:
    from skill_hub.infrastructure.harnesses import harness_validation

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = harness_validation.main(
            [
                "native",
                "--recipe",
                args.recipe,
                "--report-dir",
                str(args.report_dir),
                *(["--repo-root", str(args.repo_root)] if args.repo_root is not None else []),
                *(["--catalog", str(args.catalog)] if args.catalog is not None else []),
                *(["--authorize-native"] if args.authorize_native else []),
                *(["--json"] if args.json else []),
            ]
        )
    text = output.getvalue()
    if text:
        print(text, end="")
    return code


def _user_home() -> Path:
    from skill_hub.application.harnesses.harness_operation_context import _user_home as shared_user_home

    return shared_user_home()


def _expand_fallbacks() -> tuple[str, ...]:
    from skill_hub.application.harnesses.harness_operation_context import _expanded_fallbacks

    return _expanded_fallbacks(_user_home())


def _inventory_request(harnesses: Iterable[str]):
    from skill_hub.application.harnesses.harness_operation_context import host_inventory_request

    return host_inventory_request(tuple(harnesses))


def _cache_path() -> Path:
    from skill_hub.application.harnesses.harness_operation_context import runtime_inventory_cache_path

    return runtime_inventory_cache_path(hub_core.data_home())


def _provenance_data(args: Any) -> dict[str, Any]:
    """Read canonical inventory cache data without refreshing or probing."""
    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.domain.harnesses import harness_adapter_api, harness_catalog, harness_resolution

    selected = tuple(args.harness) or _HARNESS_IDS
    try:
        # Refresh writes the canonical all-harness snapshot. Read that first
        # and filter participants after decoding; a targeted refresh remains a
        # valid fallback for callers that explicitly requested one harness.
        request = _inventory_request(_HARNESS_IDS)
        selected_request = _inventory_request(selected)
        if request == selected_request:
            cached = harness_runtime.read_inventory_cache(_cache_path(), request)
        else:
            cached = harness_runtime.read_inventory_cache(_cache_path(), request, (selected_request,))
    except (OSError, TypeError, ValueError):
        cached = None
    catalog = harness_catalog.bundled_catalog()
    sdk_raw = getattr(harness_adapter_api, "SDK_VERSION", None)
    sdk_version = (
        sdk_raw
        if isinstance(sdk_raw, harness_adapter_api.Version)
        else harness_adapter_api.Version.parse(sdk_raw)
    )
    host_version = harness_adapter_api.Version.parse(hub_core.hub_version())
    decisions: list[dict[str, Any]] = []
    if cached is not None:
        for harness_id in sorted(set(selected)):
            features = sorted(
                {
                    str(feature)
                    for manifest in catalog.manifests
                    for variant in manifest.variants
                    if variant.harness_id == harness_id
                    for feature in variant.features
                }
            )
            if args.feature:
                # Keep explicitly requested features so the resolver records
                # an honest unsupported decision for undeclared operations.
                features = list(dict.fromkeys(args.feature))
            try:
                resolution = harness_resolution.resolve_operation(
                    cached,
                    catalog,
                    harness_resolution.ResolutionPolicy(
                        requested_harness=harness_id,
                        requested_features=tuple(features),
                        host_version=host_version,
                        sdk_version=sdk_version,
                    ),
                )
            except (TypeError, ValueError):
                continue
            for decision in resolution.decisions:
                binding = decision.binding
                decisions.append(
                    {
                        "harness_id": harness_id,
                        "feature": decision.feature,
                        "status": decision.status,
                        "reason": decision.reason,
                        "validation_provenance": decision.validation_provenance,
                        "binding": (
                            {
                                "package_id": binding.package_id,
                                "release_version": str(binding.release_version),
                                "release_digest": binding.release_digest,
                                "harness_id": binding.harness_id,
                                "variant_id": binding.variant_id,
                                "installation_id": binding.installation_id,
                                "profile": binding.profile,
                                "runtime_version": str(binding.runtime_version),
                                "validation_provenance": binding.validation_provenance,
                            }
                            if binding is not None
                            else None
                        ),
                    }
                )
    adapter = {
        "sdk_version": str(sdk_version) if sdk_version is not None else None,
        "host_version": str(host_version) if host_version is not None else None,
    }
    catalog_data = {"generation": catalog.generation, "digest": catalog.content_digest}
    if cached is None:
        return {
            "status": "not_collected",
            "runtime": {"status": "missing_or_stale", "identities": []},
            "adapter": adapter,
            "catalog": catalog_data,
            "selected_decisions": decisions,
        }
    identities = []
    for item in cached.identities:
        if item.harness_id not in selected:
            continue
        identities.append(
            {
                "harness_id": item.harness_id,
                "installation_id": item.installation_id,
                "version": str(item.version) if item.version else ("unknown" if item.raw_version else None),
            }
        )
    return {
        "status": "cache",
        "runtime": {
            "status": "fresh",
            "fingerprint": cached.request_fingerprint,
            "observed_at": cached.observed_at,
            "identities": identities,
        },
        "adapter": adapter,
        "catalog": catalog_data,
        "selected_decisions": decisions,
    }


def _inventory(args: Any) -> int:
    from skill_hub.application.harnesses import harness_runtime

    error = _validate_harnesses(args.harness)
    if error:
        return _error(error, args.json, json_read=True)
    selected = tuple(args.harness) or _HARNESS_IDS
    try:
        request = _inventory_request(selected)
        cache_path = _cache_path()
    except (OSError, ValueError, TypeError) as exc:
        return _error("cannot construct inventory request: {}".format(exc), args.json, json_read=True)
    if not args.refresh:
        try:
            cached = harness_runtime.read_inventory_cache(cache_path, request)
        except (OSError, ValueError, TypeError) as exc:
            return _error("cannot read inventory cache: {}".format(exc), args.json, json_read=True)
        if cached is None:
            status = "stale" if cache_path.exists() else "missing"
            payload: dict[str, Any] = {
                "status": status,
                "cache_path": str(cache_path),
                "identities": [],
                "errors": ["runtime inventory cache is " + status],
            }
            if status == "stale":
                try:
                    raw = json.loads(cache_path.read_text(encoding="utf-8"))
                    rows = raw.get("identities") if isinstance(raw, dict) else None
                    valid_rows = isinstance(rows, list) and all(
                        isinstance(row, dict)
                        and isinstance(row.get("harness_id"), str)
                        and isinstance(row.get("installation_id"), str)
                        for row in rows
                    )
                    if valid_rows:
                        payload["identities"] = rows
                        payload["observed_at"] = raw.get("observed_at")
                    elif rows is not None:
                        payload["errors"].append("runtime inventory cache contains malformed identity rows")
                except (OSError, ValueError):
                    pass
        else:
            payload = harness_runtime.inventory_payload(cached)
            payload.update({"status": "fresh", "source": "cache", "cache_path": str(cache_path), "errors": []})
        return _print_inventory(payload, args.json)
    try:
        observed = harness_runtime.inventory(request)
        harness_runtime.write_inventory_cache(observed, cache_path)
    except (OSError, ValueError, TypeError) as exc:
        return _error("cannot refresh inventory: {}".format(exc), args.json, json_read=True)
    payload = harness_runtime.inventory_payload(observed)
    payload.update({"status": "fresh", "source": "refresh", "cache_path": str(cache_path), "errors": []})
    return _print_inventory(payload, args.json)


def _print_inventory(payload: Mapping[str, Any], json_out: bool) -> int:
    if json_out:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print("Runtime inventory: {}".format(payload.get("status", "unknown")))
        for identity in payload.get("identities", []):
            print("- {} {}".format(identity.get("harness_id"), identity.get("version") or "unknown"))
        for error in payload.get("errors", []):
            print("! " + str(error))
    return 0


def _report(args: Any) -> int:
    try:
        from skill_hub.infrastructure.harnesses import harness_validation

        payload = harness_validation.read_report(args.path)
        if args.compare is not None:
            prior = harness_validation.read_report(args.compare)
            payload = harness_validation.compare_reports(payload, prior)
    except (OSError, ValueError, TypeError) as exc:
        return _error("cannot read report: {}".format(exc), args.json, json_read=True)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    elif args.compare is not None:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(harness_validation.format_report(payload), end="")
    return 0


def dispatch(args: Any) -> int:
    if args.integration_cmd == "list":
        return _list(args)
    if args.integration_cmd == "validate":
        return _validate(args)
    if args.integration_cmd == "native":
        return _native(args)
    if args.integration_cmd == "inventory":
        return _inventory(args)
    if args.integration_cmd == "report":
        return _report(args)
    if p_integration is not None:
        p_integration.print_help()
    return 0
