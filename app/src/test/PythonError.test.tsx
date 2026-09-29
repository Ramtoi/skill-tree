import { it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { PythonError } from "@/screens/PythonError";
import { useAppStore } from "@/store";
import { invoke as mockedInvoke } from "@/mocks/tauriCore";

// `PythonError` (`preflight`, `bootstrapError`) has no test today.

it("renders the preflight-failed state (python-too-old)", () => {
	renderWithProviders(
		<PythonError
			preflight={{ ok: false, reason: "python-too-old", detail: "Python 3.7.2", python: "/usr/bin/python3" }}
		/>,
	);

	expect(screen.getByRole("heading", { name: /Python is too old/ })).toBeVisible();
	expect(screen.getByText(/Python 3\.7\.2/)).toBeVisible();
	expect(screen.getByText("/usr/bin/python3 --version")).toBeVisible();
	expect(screen.getByRole("button", { name: "Recheck runtime" })).toBeVisible();
});

it("renders the bootstrap-failed state and 'Continue in degraded mode' flips useAppStore.degradedMode", () => {
	useAppStore.setState({ degradedMode: false });
	renderWithProviders(
		<PythonError
			preflight={{ ok: true, reason: "none", detail: null, python: "/usr/bin/python3" }}
			bootstrapError="registry.yaml is unreadable: mapping values are not allowed here (line 12, column 8)"
		/>,
	);

	expect(screen.getByRole("heading", { name: /Couldn't initialize Skill Tree/ })).toBeVisible();
	expect(
		screen.getByText("registry.yaml is unreadable: mapping values are not allowed here (line 12, column 8)"),
	).toBeVisible();

	expect(useAppStore.getState().degradedMode).toBe(false);
	fireEvent.click(screen.getByRole("button", { name: "Continue in degraded mode" }));
	expect(useAppStore.getState().degradedMode).toBe(true);
});

// Mock-fidelity: `bootstrap_check` (driven directly through the REAL mock
// dispatch, `@/mocks/tauriCore`, the way `usageAnalyticsFidelity.test.ts`
// does) rejects with the honest unreadable-registry message under
// `?screenError=1` — the scene this screen's "bootstrap-failed" branch reads.
it("`?screenError=1` makes the mocked `bootstrap_check` reject with the unreadable-registry message", async () => {
	window.history.replaceState({}, "", "/?screenError=1");
	try {
		await expect(mockedInvoke("bootstrap_check")).rejects.toThrow(
			"registry.yaml is unreadable: mapping values are not allowed here (line 12, column 8)",
		);
	} finally {
		window.history.replaceState({}, "", "/");
	}
});
