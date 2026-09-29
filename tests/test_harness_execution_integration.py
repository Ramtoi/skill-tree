"""Real entry points fail closed when the OS cannot enforce resource bounds."""
import json
import sys
from pathlib import Path
from types import MappingProxyType

import pytest

from skill_hub.infrastructure.harnesses import harness_native_executor as native
from skill_hub.infrastructure.harnesses import harness_validation as validation
from tests.test_harness_native_executor import _identity, _recipe


@pytest.mark.skipif(sys.platform != "darwin", reason="actual macOS enforcement boundary")
def test_offline_command_retains_blocked_memory_report(tmp_path, capsys):
    marker = tmp_path / "target-started"
    (tmp_path / "test_fixture.py").write_text(
        f"from pathlib import Path\ndef test_x():\n    Path({str(marker)!r}).touch()\n"
    )
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"schema_version": 1, "cases": [{
        "id": "enforcement", "description": "enforcement", "harnesses": ["pi"], "feature": "contract",
        "layer": "offline", "profiles": ["quick"], "platforms": ["macos", "linux", "windows"],
        "selectors": ["test_fixture.py"], "timeout_seconds": 5, "gap": None,
    }]}))
    assert validation.main(["run", "--profile", "quick", "--catalog", str(catalog),
                            "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]) == 1
    report = json.loads((Path(capsys.readouterr().out.strip()) / "report.json").read_text())
    assert report["cases"][0]["status"] == "blocked"
    assert "memory supervision is unavailable on macOS" in report["cases"][0]["reason"]
    assert not marker.exists()


def test_production_native_rejects_fixture_supervisor(monkeypatch):
    from dataclasses import replace
    recipe = _recipe(code="raise SystemExit('must not run')")
    production = MappingProxyType({recipe.recipe_id: recipe})
    monkeypatch.setattr(native, "NATIVE_RECIPES", production)
    result = native.execute_native(native.NativeRequest(recipe.recipe_id, True), production,
                                   replace(_identity(), evidence="probe"), supervisor=lambda *a, **kw: None)
    assert result.status == "blocked"
    assert "system supervisor" in result.reason


@pytest.mark.skipif(sys.platform != "darwin", reason="actual macOS enforcement boundary")
def test_native_fixture_with_system_supervisor_is_blocked():
    recipe = _recipe(code="raise SystemExit('must not run')")
    result = native.execute_native(
        native.NativeRequest(recipe.recipe_id, True), {recipe.recipe_id: recipe}, _identity()
    )
    assert result.status == "blocked"
    assert "memory supervision is unavailable on macOS" in result.reason
