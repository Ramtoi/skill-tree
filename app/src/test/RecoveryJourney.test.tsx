import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "./helpers";
import { RecoveryWizard } from "@/screens/RecoveryWizard";
import { mockRecovery } from "@/mocks/recovery";

/**
 * The full five-step recovery journey against the SAME deterministic mock the
 * visual harness/e2e use (`mocks/recovery.ts`), not a per-test hand-rolled
 * fixture — this is what proves the wizard, the mock's production-shaped
 * state (registry attachment consistency, structured refusals), and a
 * reload/reopen all agree with each other, per the parent's integration
 * findings.
 *
 * Covers: sources retry, project repository association + an `ambiguous_remote`
 * refusal that STAYS actionable (retry with a remote rather than the action
 * disappearing), local-only source skip, sync, a gated finish, and reopening
 * a dismissed journey that still has a retryable failed row (F2/A9/A10).
 */

function queueDirectoryPicks(paths: string[]) {
	const queue = [...paths];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "pick_directory") return queue.shift() ?? null;
		if (cmd === "recovery_command") {
			return mockRecovery((args as { args: string[] }).args);
		}
		return undefined;
	}) as never);
}

beforeEach(() => {
	window.sessionStorage.clear();
});

describe("Recovery journey — end to end against the deterministic mock", () => {
	it("walks sources → projects (incl. an ambiguous_remote retry) → remaining → sync → finish, then reopens with the failed row still retryable", async () => {
		const user = userEvent.setup();
		queueDirectoryPicks([
			// "skill-tree" (has a repository): direct-select a path the mock
			// scripts as ambiguous — the retry-with-remote field must resolve it.
			"/dev/multi-remote-checkout",
			// "dev" (no repository): local-checkout tab, plain attach.
			"/dev/dev-checkout",
		]);

		// `sceneFlag`'s `?restoreRecovery=1` reads the real `window.location`,
		// which `MemoryRouter` never touches — seed the mock the same way
		// `BootstrapRestoreStep` does after a real restore apply: an explicit
		// `start` call.
		mockRecovery(["start"]);
		const mounted = renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });

		// ── Sources ──────────────────────────────────────────────────────────
		await screen.findByTestId("recovery-sources-step");
		await user.click(screen.getByTestId("recovery-source-skip-diagnosing-bugs"));
		await waitFor(() =>
			expect(screen.getByTestId("recovery-source-row-diagnosing-bugs")).toHaveAttribute(
				"data-status",
				"skipped",
			),
		);
		await user.click(screen.getByTestId("recovery-source-skip-codebase-design"));
		await waitFor(() =>
			expect(screen.getByTestId("recovery-source-row-codebase-design")).toHaveAttribute(
				"data-status",
				"skipped",
			),
		);
		// "unslop" deliberately left FAILED (untouched) — resolved later, after
		// reopening a dismissed journey, to prove a failure stays retryable.
		expect(screen.getByTestId("recovery-source-row-unslop")).toHaveAttribute("data-status", "failed");

		// ── Projects ─────────────────────────────────────────────────────────
		await user.click(screen.getByTestId("recovery-nav-next"));
		await screen.findByTestId("recovery-projects-step");

		// "skill-tree" has a repository → the Attach picker, direct selection,
		// hits the scripted `ambiguous_remote` refusal.
		await user.click(screen.getByTestId("recovery-project-attach-skill-tree"));
		await user.click(await screen.findByTestId("recovery-attach-direct-btn"));
		// Blank the remote first — this is the shape that hits the mock's
		// scripted `ambiguous_remote` refusal for this magic path.
		const remoteInput = await screen.findByLabelText(/Git remote/i);
		await user.clear(remoteInput);
		await user.click(screen.getByTestId("recovery-attach-direct-confirm"));
		const attachError = await screen.findByTestId("recovery-attach-error");
		expect(attachError).toHaveTextContent(/multiple remotes/i);
		// The action is STILL there — a refusal must not remove the retry path.
		const retryBtn = screen.getByTestId("recovery-attach-direct-confirm");
		expect(retryBtn).toBeInTheDocument();
		await user.type(remoteInput, "origin");
		await user.click(retryBtn);
		await waitFor(() =>
			expect(screen.queryByTestId("recovery-project-attach-skill-tree")).not.toBeInTheDocument(),
		);

		// "dev" has no repository → the repository picker's local-checkout tab.
		await user.click(screen.getByTestId("recovery-project-connect-dev"));
		await user.click(await screen.findByTestId("recovery-picker-tab-local"));
		await user.click(screen.getByRole("button", { name: /Browse…/i }));
		await user.click(await screen.findByTestId("recovery-attach-local-folder"));
		await waitFor(() =>
			expect(screen.queryByTestId("recovery-project-connect-dev")).not.toBeInTheDocument(),
		);

		// "spectrebox" was already attached in the seed — no row action needed.

		// ── Remaining (local-only sources) ──────────────────────────────────
		await user.click(screen.getByTestId("recovery-nav-next"));
		await screen.findByTestId("recovery-remaining-step");
		await user.click(screen.getByTestId("recovery-local-source-skip-gh-fix-ci"));
		await user.click(screen.getByTestId("recovery-local-source-skip-skt-mcp"));
		await waitFor(() => {
			expect(screen.getByTestId("recovery-local-source-row-gh-fix-ci")).toHaveAttribute(
				"data-status",
				"skipped",
			);
			expect(screen.getByTestId("recovery-local-source-row-skt-mcp")).toHaveAttribute(
				"data-status",
				"skipped",
			);
		});

		// ── Sync ─────────────────────────────────────────────────────────────
		await user.click(screen.getByTestId("recovery-nav-next"));
		await screen.findByTestId("recovery-sync-step");
		// A failed source requires retry, skip, or explicit deferral.
		expect(screen.getByTestId("recovery-finish-btn")).toHaveAttribute("aria-disabled", "true");
		await user.click(screen.getByTestId("recovery-sync-run"));
		await screen.findByTestId("recovery-sync-result");

		// ── Finish ───────────────────────────────────────────────────────────
		expect(screen.getByTestId("recovery-finish-btn")).toHaveAttribute("aria-disabled", "true");
		await user.click(screen.getByTestId("recovery-defer-btn"));
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"recovery_command",
				expect.objectContaining({ args: ["finish", "--defer"] }),
			);
		});

		// ── Reopen: unmount + remount (simulates leaving and reopening from
		//    Backup, or a real app relaunch) — the SAME mock module still holds
		//    state (sessionStorage-backed), so this also proves A10 (restart
		//    resumes without re-applying the snapshot). ─────────────────────
		mounted.unmount();
		renderWithProviders(<RecoveryWizard />, { initialRoute: "/recovery" });

		expect(await screen.findByText(/You closed this recovery earlier/i)).toBeInTheDocument();
		// Reopening lands on the LAST persisted stage ("sync" — every `Continue`
		// click wrote it as the journey advanced). The failed source is still
		// reachable one tab away, and still retryable: dismissing never removes
		// it (PLAN.md: "Failures remain retryable").
		await user.click(screen.getByTestId("recovery-stage-tab-sources"));
		const unslopRow = await screen.findByTestId("recovery-source-row-unslop");
		expect(unslopRow).toHaveAttribute("data-status", "deferred");
		await user.click(screen.getByTestId("recovery-source-recover-unslop"));
		await waitFor(() =>
			expect(screen.getByTestId("recovery-source-row-unslop")).toHaveAttribute("data-status", "ready"),
		);
	});
});
