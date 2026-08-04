import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoke } from "@tauri-apps/api/core";

import { StatusBar } from "@/components/StatusBar";
import { renderWithProviders, sampleRegistry } from "@/test/helpers";

/**
 * StatusBar backup chip. Backup is fail-OPEN by design — a failed snapshot must
 * never break a sync — which is exactly why it must not be fail-SILENT. These
 * tests pin both halves: the chip appears for the two conditions the design
 * names, and it stays out of the way for everything else.
 */

const healthy = {
	enabled: true,
	initialized: true,
	configured: true,
	dir: "~/.skill-hub-backup",
	remote: "git@github.com:me/b.git",
	repo: "me/b",
	branch: "main",
	auth: {
		configured: "auto",
		pat_available: true,
		pat_detail: "stored",
		gh_login: "me",
		gh_active_login: "me",
		gh_account_mismatch: false,
	},
	push_failures: 0,
	last_push_error: null,
	pending_reconcile: false,
	last_commit: null,
	ahead: 0,
	behind: 0,
	drift: "in-sync",
	manifest: null,
	warnings: [],
};

function mockStatus(over: Record<string, unknown> = {}, reportBackupSlot?: unknown) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "backup_status") return { ...healthy, ...over };
		if (cmd === "read_registry") return sampleRegistry;
		if (cmd === "sync_report" && reportBackupSlot !== undefined) {
			return {
				report: {
					schema_version: 1,
					generated_at: "2026-08-04T09:00:00Z",
					registry_sha256: "abc",
					registry_mtime: 1,
					ok: true,
					global: { backup: reportBackupSlot },
					projects: {},
				},
				registry_current: { sha256: "abc", mtime: 1 },
			};
		}
		return prev ? prev(cmd as never, args as never) : undefined;
	}) as never);
}

beforeEach(() => mockStatus());

describe("StatusBar backup chip", () => {
	it("stays hidden when the backup is healthy", async () => {
		renderWithProviders(<StatusBar />);
		// Wait for the bar itself so the absence below isn't just "not mounted yet".
		await screen.findByText(/palette/i);
		await waitFor(() => expect(screen.queryByTestId("backup-chip")).toBeNull());
	});

	it("stays hidden when backup was never configured", async () => {
		mockStatus({ configured: false, push_failures: 7 });
		renderWithProviders(<StatusBar />);
		await screen.findByText(/palette/i);
		await waitFor(() => expect(screen.queryByTestId("backup-chip")).toBeNull());
	});

	it("shows a danger chip once push failures reach the threshold", async () => {
		mockStatus({ push_failures: 3, last_push_error: "auth expired" });
		renderWithProviders(<StatusBar />);

		const chip = await screen.findByTestId("backup-chip");
		expect(chip).toHaveAttribute("data-backup-state", "danger");
		expect(chip).toHaveTextContent(/backup stale/i);
		expect(chip).toHaveTextContent("3");
		expect(chip).toHaveAttribute("title", "auth expired");
	});

	it("does not shout one failure below the threshold", async () => {
		mockStatus({ push_failures: 2 });
		renderWithProviders(<StatusBar />);
		await screen.findByText(/palette/i);
		await waitFor(() => expect(screen.queryByTestId("backup-chip")).toBeNull());
	});

	it("shows a warn chip while a restore reconcile is pending", async () => {
		mockStatus({ pending_reconcile: true });
		renderWithProviders(<StatusBar />);

		const chip = await screen.findByTestId("backup-chip");
		expect(chip).toHaveAttribute("data-backup-state", "warn");
		expect(chip).toHaveTextContent(/restore pending/i);
	});

	it("escalates a refused publish recorded in the sync report to danger", async () => {
		mockStatus({}, {
			ran: true,
			skipped: null,
			committed: false,
			pushed: false,
			conflict: false,
			error: "token-shaped string in snippets/a.md:12",
			error_kind: "secret_leak",
			at: "2026-08-04T09:00:00Z",
		});
		renderWithProviders(<StatusBar />);

		const chip = await screen.findByTestId("backup-chip");
		expect(chip).toHaveAttribute("data-backup-state", "danger");
		expect(chip).toHaveTextContent(/refused/i);
		expect(chip).toHaveAttribute("title", "token-shaped string in snippets/a.md:12");
	});

	/**
	 * Narrow-width survival, guarded at the source.
	 *
	 * jsdom applies no stylesheet, so a rendering test can never catch this: the
	 * chip was hidden outright at ≤680px by the status bar's "drop the low-signal
	 * title-carrying segments" rule, which matches on `[title]` and exempted only
	 * `.update-chip`. A fail-OPEN backup pass that is also fail-SILENT below a
	 * window width is exactly the failure the chip exists to prevent.
	 *
	 * The behavioural version of this runs with real CSS at 520px in
	 * `e2e/backup.journey.spec.ts`; this is the cheap source-level net.
	 */
	it("is exempt from the narrow-width status-bar drop rule", async () => {
		// Read the stylesheet as a FILE: jsdom applies no CSS, and Vite serves
		// `import.meta.url` over http, so the source is the only observable.
		const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");

		const dropRule = css.match(
			/@media \(max-width: 680px\)\s*\{[\s\S]*?display: none;[\s\S]*?\}/,
		)?.[0];
		expect(dropRule, "the narrow-width status-bar drop rule").toBeTruthy();
		expect(dropRule).toContain(":not(.backup-chip)");

		// The generic clip rule must not claim it either…
		const clipRule = css.match(
			/\.app-status > \.status-segment\[title\][^{]*\{[^}]*flex-shrink[^}]*\}/,
		)?.[0];
		expect(clipRule, "the status-segment shrink/clip rule").toBeTruthy();
		expect(clipRule).toContain(":not(.backup-chip)");

		// …because the chip has its OWN: it stays visible and ellipsizes rather
		// than pinning at full width and pushing the ⌘K trigger off the edge.
		expect(css).toMatch(/\.app-status > \.status-segment\.backup-chip \{[^}]*flex-shrink: 1/);
		expect(css).toMatch(/\.backup-chip-label \{[^}]*text-overflow: ellipsis/);
		// The low-signal path segment must yield its width BEFORE the chip does.
		expect(clipRule, "the path segment shrinks harder than the chip").toContain("flex-shrink: 6");
	});

	it("carries the class and the label hook those rules key off", async () => {
		mockStatus({ pending_reconcile: true });
		const { container } = renderWithProviders(<StatusBar />);
		const chip = await screen.findByTestId("backup-chip");
		expect(chip).toHaveClass("backup-chip");
		// The rules only apply to DIRECT children of `.app-status`, and only the
		// title attribute makes the drop rule match at all.
		expect(chip).toHaveAttribute("title");
		expect(chip.parentElement).toHaveClass("app-status");
		// The label lives in its own element so it can ellipsize.
		expect(container.querySelector(".backup-chip-label")).toHaveTextContent(/restore pending/i);
	});

	it("routes to the Backup screen when clicked", async () => {
		mockStatus({ pending_reconcile: true });
		renderWithProviders(<StatusBar />);
		const chip = await screen.findByTestId("backup-chip");
		// It is a real button, so it is keyboard-reachable — not a decorative span.
		expect(chip.tagName).toBe("BUTTON");
	});
});
