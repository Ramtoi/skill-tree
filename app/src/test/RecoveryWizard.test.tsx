import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useLocation } from "react-router-dom";
import { renderWithProviders, mockCommands } from "./helpers";
import { RecoveryWizard } from "@/screens/RecoveryWizard";

/**
 * `/recovery` — the resumable finish-setup journey (F1/F2). These are
 * component-level checks against the `recovery_command` contract, not a full
 * browser journey (see `RecoveryJourney.test.tsx` for the multi-stage walk);
 * the point here is that the wizard reads the status shape correctly, sends
 * the right verb+args for each action, and gates Finish honestly.
 */

function statusPayload(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		operation_id: "op-1",
		stage: "sources",
		needs_recovery: true,
		dismissed: false,
		completed: false,
		bootstrap: { completed: true, completed_at: "2026-09-23T18:03:01Z", restored_from: "example/backup" },
		backup: { pending_reconcile: true },
		projects: [],
		projects_summary: { ready: 0, pending: 0, skipped: 0, failed: 0, interrupted: 0, total: 0 },
		sources: [
			{
				id: "unslop",
				url: "https://github.com/example/unslop.git",
				cache: "~/.skill-hub/sources/unslop",
				healthy: false,
				status: "failed",
				detail: "previous attempt timed out",
			},
		],
		local_sources: [],
		...overrides,
	};
}

function mockInvoke(handlers: Record<string, (args: unknown) => unknown>) {
	mockCommands(handlers);
}

function LocationProbe() {
	const location = useLocation();
	return <span data-testid="location-path">{location.pathname}</span>;
}

describe("RecoveryWizard", () => {
	it("keeps deferred sources individually recoverable without promising a batch retry", async () => {
		const user = userEvent.setup();
		mockInvoke({ recovery_command: () => statusPayload({
			sources: ["one", "two"].map((id) => ({ ...statusPayload().sources[0], id, status: "deferred" })),
		}) });
		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });
		await screen.findByTestId("recovery-sources-step");
		expect(screen.queryByTestId("recovery-sources-recover-all")).not.toBeInTheDocument();
		await user.click(screen.getByTestId("recovery-source-recover-one"));
		expect(invoke).toHaveBeenCalledWith("recovery_command", { args: ["restore-source", "one"] });
	});

	it("renders the sources step from a live status read and lets a failed source retry", async () => {
		const user = userEvent.setup();
		let recovered = false;
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") return recovered ? statusPayload({ sources: [{ ...statusPayload().sources[0], status: "ready", detail: null }] }) : statusPayload();
				if (a[0] === "restore-source") {
					recovered = true;
					return { ok: true, results: [{ source: "unslop", ok: true, detail: null }] };
				}
				if (a[0] === "stage") return statusPayload();
				return statusPayload();
			},
		});

		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });

		expect(await screen.findByTestId("recovery-sources-step")).toBeInTheDocument();
		const row = screen.getByTestId("recovery-source-row-unslop");
		expect(within(row).getByText("unslop")).toBeInTheDocument();
		expect(within(row).getByText("previous attempt timed out")).toBeInTheDocument();

		await user.click(screen.getByTestId("recovery-source-recover-unslop"));

		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"recovery_command",
				expect.objectContaining({ args: ["restore-source", "unslop"] }),
			);
		});
	});

	it("shows the nothing-to-recover state only when there is no recovery record at all (A14: healthy install)", async () => {
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") {
					return {
						ok: true,
						operation_id: null,
						stage: null,
						needs_recovery: false,
						dismissed: false,
						completed: false,
						bootstrap: { completed: true, completed_at: null, restored_from: null },
						backup: { pending_reconcile: false },
						projects: [],
						projects_summary: { ready: 0, pending: 0, skipped: 0, failed: 0, interrupted: 0, total: 0 },
						sources: [],
						local_sources: [],
					};
				}
				return statusPayload();
			},
		});

		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });

		expect(await screen.findByText(/Nothing to recover here/i)).toBeInTheDocument();
	});

	it("keeps the wizard reachable for a dismissed (finished) journey that still has open rows", async () => {
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") {
					return statusPayload({ needs_recovery: false, dismissed: true, completed: true });
				}
				return statusPayload();
			},
		});

		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });

		// The dismissed banner AND the still-open source row must both render —
		// dismissing must not hide a row nobody ever resolved.
		expect(await screen.findByText(/You closed this recovery earlier/i)).toBeInTheDocument();
		expect(screen.getByTestId("recovery-source-row-unslop")).toBeInTheDocument();
	});

	it("refuses to finish while a row is still pending (untouched), and names why", async () => {
		const user = userEvent.setup();
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") {
					// A genuinely untouched row — never attempted, never skipped —
					// as distinct from the "failed" fixture (an attempt was made,
					// which is allowed to finish with per PLAN.md's retryable-failure
					// rule).
					return statusPayload({
						sources: [{ ...statusPayload().sources[0], status: "pending", detail: null }],
					});
				}
				return statusPayload();
			},
		});

		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });
		await screen.findByTestId("recovery-sources-step");

		// Navigate to the last stage without resolving the failed source.
		await user.click(screen.getByTestId("recovery-stage-tab-sync"));
		await screen.findByTestId("recovery-sync-step");

		// The Button primitive soft-disables (keeps it focusable, `aria-disabled`
		// + a `title` reason) rather than a native `disabled` — clicking must be
		// a no-op either way.
		const finishBtn = screen.getByTestId("recovery-finish-btn");
		expect(finishBtn).toHaveAttribute("aria-disabled", "true");
		expect(finishBtn).toHaveAttribute(
			"title",
			expect.stringContaining("Every source and project needs an outcome"),
		);
		await user.click(finishBtn);
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"recovery_command",
			expect.objectContaining({ args: ["finish"] }),
		);
	});

	it("finish sends the finish verb once every row is resolved and a sync has been attempted", async () => {
		const user = userEvent.setup();
		let syncCurrent = false;
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") {
					// Every row resolved (skipped) — only the sync attempt is left.
					return statusPayload({
						sources: [{ ...statusPayload().sources[0], status: "skipped" }],
						sync_current: syncCurrent,
					});
				}
				if (a[0] === "sync") {
					syncCurrent = true;
					return {
						ok: true,
						counts: { success: 0, skipped: 1, failed: 0 },
						failed_projects: [],
						global_failures: [],
						error: null,
					};
				}
				if (a[0] === "finish") return statusPayload({ completed: true, dismissed: true });
				return statusPayload();
			},
		});

		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });
		await screen.findByTestId("recovery-sources-step");

		await user.click(screen.getByTestId("recovery-stage-tab-sync"));
		await screen.findByTestId("recovery-sync-step");

		expect(screen.getByTestId("recovery-finish-btn")).toHaveAttribute("aria-disabled", "true");

		await user.click(screen.getByTestId("recovery-sync-run"));
		await waitFor(() =>
			expect(screen.getByTestId("recovery-finish-btn")).not.toHaveAttribute("aria-disabled"),
		);

		await user.click(screen.getByTestId("recovery-finish-btn"));

		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"recovery_command",
				expect.objectContaining({ args: ["finish"] }),
			);
		});
	});

	it("Finish later returns to Library after the backend confirms the defer", async () => {
		const user = userEvent.setup();
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") return statusPayload();
				if (a[0] === "finish") return statusPayload({ dismissed: true, completed: true });
				return statusPayload();
			},
		});

		renderWithProviders(<><RecoveryWizard /><LocationProbe /></>, { initialRoute: "/recovery" });
		await screen.findByTestId("recovery-sources-step");

		await user.click(screen.getByTestId("recovery-defer-btn"));
		await waitFor(() => expect(screen.getByTestId("location-path")).toHaveTextContent("/"));
	});

	it("keeps ordinary Finish disabled after a failed current sync and explains the retry path", async () => {
		const user = userEvent.setup();
		mockInvoke({
			recovery_command: (args) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "status") {
					return statusPayload({
						sources: [{ ...statusPayload().sources[0], status: "skipped" }],
						sync_current: true,
						sync_result: {
							ok: false,
							counts: { success: 0, skipped: 0, failed: 1 },
							failed_projects: ["dev"],
							project_failures: { dev: ["Could not write project files"] },
							global_failures: [],
							error: null,
						},
					});
				}
				return statusPayload();
			},
		});

		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });
		await screen.findByTestId("recovery-sources-step");
		await user.click(screen.getByTestId("recovery-stage-tab-sync"));

		const finish = await screen.findByTestId("recovery-finish-btn");
		expect(finish).toHaveAttribute("aria-disabled", "true");
		expect(finish).toHaveAttribute("title", expect.stringContaining("run sync again"));
		expect(screen.getByTestId("recovery-project-failures")).toHaveTextContent("Could not write project files");
		await user.click(finish);
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"recovery_command",
			expect.objectContaining({ args: ["finish"] }),
		);
	});
});
