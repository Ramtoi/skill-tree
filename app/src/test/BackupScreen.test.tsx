import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

import { BackupScreen } from "@/screens/BackupScreen";
import { ToastContainer } from "@/components/Toast";
import { deferredInvoke, renderWithProviders } from "@/test/helpers";
import { RESTORE_MODE_HINT } from "@/lib/backupContract";

/** The screen plus the toast surface — several of its outcomes (a scrubbed
 *  push error, a failed keychain write) are reported ONLY as a toast, so
 *  rendering the screen alone would make those assertions vacuous. */
function renderScreen() {
	return renderWithProviders(
		<>
			<BackupScreen />
			<ToastContainer />
		</>,
	);
}

/**
 * Backup screen contract. The two properties worth guarding hardest are the
 * ones a refactor could silently break without failing a type check:
 *
 * - a PAT never survives submission anywhere in the DOM, and
 * - a degraded credential ladder explains ITSELF (the CLI's reason string),
 *   rather than the UI inventing a generic "unavailable".
 */

const okStatus = {
	enabled: true,
	initialized: true,
	configured: true,
	dir: "~/.skill-hub-backup",
	remote: "git@github.com:me/skill-tree-backup.git",
	repo: "me/skill-tree-backup",
	branch: "main",
	auth: {
		configured: "auto",
		pat_available: true,
		pat_detail: "token stored",
		gh_login: "me",
		gh_active_login: "me",
		gh_account_mismatch: false,
	},
	push_failures: 0,
	last_push_error: null,
	pending_reconcile: false,
	last_commit: {
		sha: "9f2c1ab77e40d3b1",
		ts: "2026-08-04T09:12:44Z",
		subject: "snapshot from moon-base",
	},
	ahead: 0,
	behind: 0,
	drift: "in-sync",
	manifest: null,
	warnings: [],
};

const okAuth = {
	method: "ssh",
	configured: "auto",
	ladder: [
		{ method: "ssh", available: true, detail: "authenticated to github.com as me", user: "me" },
		{ method: "gh", available: true, detail: "gh CLI authenticated as me", user: "me" },
		{ method: "pat", available: true, detail: "token stored in your OS keychain", user: null },
	],
	keyring_available: true,
	pat_available: true,
	pat_detail: "token stored in your OS keychain",
	gh_login: "me",
	create_method: "gh",
};

/** The whole toast, given any node inside it. `addToast` splits a message at
 *  " — " into a title div and a body div, so asserting on the matched node
 *  alone would miss the half that carries the error detail. */
function toastOf(node: HTMLElement): HTMLElement {
	return (node.closest(".toast") as HTMLElement | null) ?? node;
}

/** Install a backup-aware invoke, deferring to setup.ts for everything else. */
function mockBackup(over: Record<string, unknown> = {}) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd in over) {
			const v = over[cmd];
			return typeof v === "function" ? (v as (a?: unknown) => unknown)(args) : v;
		}
		if (cmd === "backup_status") return okStatus;
		if (cmd === "backup_auth_status") return okAuth;
		return prev ? prev(cmd as never, args as never) : undefined;
	}) as never);
}

beforeEach(() => mockBackup());

/**
 * Once a backup works, credential management is maintenance — it lives behind a
 * disclosure so the health of the backup leads. Every credential assertion
 * therefore opens it first, which is itself the contract: the section must be
 * reachable in exactly one click from the configured screen.
 */
async function openCredentials(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByTestId("backup-credential-disclosure"));
}

describe("BackupScreen — status", () => {
	it("renders the repo, branch, and last snapshot", async () => {
		renderScreen();
		expect(await screen.findByText("git@github.com:me/skill-tree-backup.git")).toBeInTheDocument();
		expect(screen.getByText("main")).toBeInTheDocument();
		expect(screen.getByText("snapshot from moon-base")).toBeInTheDocument();
		// Short sha, not the full one — the card is a summary.
		expect(screen.getByText("9f2c1ab77e40")).toBeInTheDocument();
	});

	it("leads with the guided journey — not a health card — when nothing is set up", async () => {
		mockBackup({
			backup_status: { ...okStatus, configured: false, initialized: false, last_commit: null },
		});
		renderScreen();
		expect(await screen.findByTestId("backup-journey")).toBeInTheDocument();
		// The maintenance layout is absent entirely: there is no health to report.
		expect(screen.queryByTestId("backup-health")).not.toBeInTheDocument();
		expect(screen.queryByTestId("backup-credential-disclosure")).not.toBeInTheDocument();
	});

	it("surfaces a consecutive-push-failure run as an error card, not a silent count", async () => {
		mockBackup({
			backup_status: {
				...okStatus,
				push_failures: 4,
				last_push_error: "remote: Invalid username or password",
			},
		});
		renderScreen();
		// The headline error card AND the health card's "Cloud copy" row — both
		// read the same `backupHealth`, which is the point.
		expect(
			(await screen.findAllByText(/backup failing · 4 failed pushes/i)).length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText(/Invalid username or password/).length).toBeGreaterThan(0);
	});

	/**
	 * The blocker: the header chip and the "Cloud copy" row both read `drift`
	 * (in-sync ⇒ a green "in sync with remote") while the error card beside them
	 * announced four failed pushes. Both read `backupHealth` now.
	 */
	it("never claims to be in sync while pushes are failing", async () => {
		mockBackup({
			backup_status: {
				...okStatus,
				drift: "in-sync",
				push_failures: 4,
				last_push_error: "remote: Invalid username or password",
			},
		});
		const { container } = renderScreen();
		await screen.findByTestId("backup-health");

		expect(screen.queryByText(/in sync with remote/i)).not.toBeInTheDocument();
		// Every freshness surface on the screen sits in the error channel.
		const badges = container.querySelectorAll(".fresh-badge");
		expect(badges.length).toBeGreaterThan(0);
		for (const b of badges) expect(b.getAttribute("data-state")).toBe("error");
	});

	/** One surface owns the words: the card spells the sentence, the header
	 *  carries the short form, so neither repeats the other. */
	it("spells the state once — compact in the header, full in the card", async () => {
		renderScreen();
		await screen.findByTestId("backup-health");
		expect(screen.getAllByText("in sync with remote")).toHaveLength(1);
		expect(screen.getByText("backed up")).toBeInTheDocument();
	});

	/** "Local clone" read as a throwaway checkout of the remote. It is the
	 *  working copy snapshots are built in, and its path is whatever the
	 *  registry recorded — never a hardcoded default. */
	it("labels the working copy honestly and shows the configured path", async () => {
		mockBackup({ backup_status: { ...okStatus, dir: "/somewhere/custom/backup" } });
		renderScreen();
		await screen.findByTestId("backup-health");
		expect(screen.getByText("Local working copy")).toBeInTheDocument();
		expect(screen.queryByText("Local clone")).not.toBeInTheDocument();
		expect(screen.getByText("/somewhere/custom/backup")).toBeInTheDocument();
	});

	/** A prose restatement of `push_failures` used to arrive in `status.warnings`
	 *  and land in the BLUE informational banner, right beside the same fact in
	 *  red. `backup.py` stopped emitting it; the screen must not resurrect it. */
	it("does not repeat the failure count in the informational channel", async () => {
		mockBackup({
			backup_status: { ...okStatus, push_failures: 4, last_push_error: "nope", warnings: [] },
		});
		const { container } = renderScreen();
		await screen.findByTestId("backup-health");
		expect(container.querySelector(".info-banner")).toBeNull();
	});

	it("blocks pushes behind a pending_reconcile banner with an acknowledge action", async () => {
		mockBackup({ backup_status: { ...okStatus, pending_reconcile: true } });
		renderScreen();
		expect(await screen.findByTestId("pending-reconcile-banner")).toBeInTheDocument();
		expect(screen.getByTestId("acknowledge-restore")).toBeInTheDocument();
		expect(screen.getByText(/commit but not/i)).toBeInTheDocument();
	});

	/** Nothing is reaching the cloud while a reconcile is pending, so the chip
	 *  must not read green — even with `drift: "in-sync"`. */
	it("shows a neutral, never green, header chip while paused", async () => {
		mockBackup({
			backup_status: { ...okStatus, pending_reconcile: true, drift: "in-sync" },
		});
		const { container } = renderScreen();
		await screen.findByTestId("pending-reconcile-banner");
		for (const b of container.querySelectorAll(".fresh-badge")) {
			expect(b.getAttribute("data-state")).not.toBe("fresh");
		}
		expect(screen.getByText("paused")).toBeInTheDocument();
	});

	/** The collapsed row promises only what holds in BOTH modes. It must not
	 *  make merge's conflict claim (that lives on the mode picker inside, from
	 *  the same shared constant) and it must not promise destruction the default
	 *  flow doesn't do. */
	it("hints the restore section mode-neutrally", async () => {
		renderScreen();
		const head = await screen.findByTestId("backup-restore-disclosure");
		expect(head).toHaveTextContent(RESTORE_MODE_HINT);
		expect(head).not.toHaveTextContent(/replaces what's here/i);
		expect(head).not.toHaveTextContent(/wins/i);
	});

	/** One heading per section. The disclosure row already names this one, so the
	 *  card inside must not repeat it ~80px lower — at 520px the two titles stack
	 *  and read as two separate sections. */
	it("does not repeat the section heading inside the opened disclosure", async () => {
		const user = userEvent.setup();
		renderScreen();
		await user.click(await screen.findByTestId("backup-restore-disclosure"));
		const zone = await screen.findByTestId("restore-danger-zone");
		expect(
			within(zone).queryByRole("heading", { name: /Restore from a snapshot/i }),
		).toBeNull();
	});

	/**
	 * Prose belongs in sans (COMPONENTS.md §Type — mono is for identifiers), and
	 * `.crumbs` pins every child at `flex-shrink: 0` under `overflow: hidden`,
	 * which guillotined the sentence mid-word instead of ellipsizing it.
	 */
	it("sets the header subtitle as prose, not as a crumb identifier", async () => {
		const { container } = renderScreen();
		await screen.findByTestId("backup-health");
		const sub = container.querySelector(".header-subline");
		expect(sub).not.toBeNull();
		// STATE-NEUTRAL: it says what the feature is for, never that the remote
		// copy is currently current — the same subtitle renders above an error
		// card reporting four rejected pushes.
		expect(sub?.textContent).toMatch(/private git repo/i);
		expect(sub?.textContent).not.toMatch(/is snapshotted/i);
	});
});

describe("BackupScreen — auth ladder", () => {
	it("lists every rung and marks the one that will push", async () => {
		const user = userEvent.setup();
		renderScreen();
		await openCredentials(user);
		expect(await screen.findByTestId("auth-rung-ssh")).toBeInTheDocument();
		expect(screen.getByTestId("auth-rung-gh")).toBeInTheDocument();
		expect(screen.getByTestId("auth-rung-pat")).toBeInTheDocument();
		expect(screen.getByText("used for push")).toBeInTheDocument();
	});

	/** COMPONENTS.md §Accents: --anchor is the BRAND channel — active / primary
	 *  / focus. A tag stating which rung pushes is a fact about a row, not a
	 *  control, so it must not borrow the one colour that means "interactive".
	 *  Checks --ctx too — neither half of the split brand accent belongs here. */
	it("marks the pushing rung without spending the brand accent on it", async () => {
		const user = userEvent.setup();
		renderScreen();
		await openCredentials(user);
		const tag = await screen.findByText("used for push");
		const style = tag.getAttribute("style") ?? "";
		expect(style).not.toContain("--violet");
		expect(style).not.toContain("--anchor");
		expect(style).not.toContain("--ctx");
		expect(style).toContain("transparent");
	});

	it("explains a degraded PAT rung with the CLI's own reason (pat_available: false)", async () => {
		mockBackup({
			backup_auth_status: {
				...okAuth,
				keyring_available: false,
				pat_available: false,
				pat_detail: "the `keyring` package is not installed",
				ladder: [
					...okAuth.ladder.slice(0, 2),
					{
						method: "pat",
						available: false,
						detail: "the `keyring` package is not installed",
						user: null,
					},
				],
			},
		});
		const user = userEvent.setup();
		renderScreen();
		await openCredentials(user);
		/**
		 * PRODUCT TERMS in the banner, the CLI's exact words on the ROW.
		 *
		 * This used to render "Token storage is unavailable: the `keyring` package
		 * is not installed. Use an SSH key or `gh` instead." — literal backticks
		 * in sans prose, a Python package name as the explanation, and a bare
		 * `gh` as the remedy. The exact reason is not discarded: it is still the
		 * `pat` rung's own detail, one hover away, where a developer can find it.
		 */
		const note = await screen.findByTestId("pat-unavailable");
		expect(note.textContent).not.toContain("`");
		expect(note.textContent).not.toMatch(/keyring|package/i);
		expect(note).toHaveTextContent(/store a token securely/i);
		expect(note).toHaveTextContent(/SSH key or the GitHub CLI/i);

		// …and the CLI's reason survives, on the row it is about.
		expect(
			screen.getByTestId("auth-rung-pat").querySelector(".cred-rung-human"),
		).toHaveAttribute("title", expect.stringContaining("keyring"));

		// A rung that cannot work must not offer its action.
		expect(screen.queryByTestId("open-pat-form")).not.toBeInTheDocument();
	});

	it("warns when gh is signed in as a different account than the backup was configured with", async () => {
		mockBackup({
			backup_status: {
				...okStatus,
				auth: { ...okStatus.auth, gh_active_login: "other-account", gh_account_mismatch: true },
			},
		});
		renderScreen();
		const warn = await screen.findByTestId("gh-account-mismatch");
		expect(warn).toHaveTextContent("other-account");
		// The command lives in ONE element, verbatim and copyable. Assembled out
		// of JSX text plus an interpolated login it rendered as
		// `gh auth switch--user me` — a command that does not exist.
		const cmd = warn.querySelector("code.cred-cmd");
		expect(cmd?.textContent).toBe("gh auth switch --user me");
		expect(warn.querySelector('button[title*="Copy"]')).not.toBeNull();
		// Scoped to what `gh` is actually used for. Pushing goes over whichever
		// rung `auth.method` resolved to, so this must not read as the reason a
		// push failed.
		expect(warn).toHaveTextContent(/creating repos/i);
		expect(warn).toHaveTextContent(/Pushing is unaffected/i);
	});

	/** A rejected push is a CREDENTIAL problem. The `gh auth switch` command
	 *  fixes repo creation and nothing else — pairing it with push failures sent
	 *  people to switch GitHub accounts over an expired token. */
	it("pairs push failures with a credential remedy, not the gh-account command", async () => {
		mockBackup({
			backup_status: {
				...okStatus,
				push_failures: 4,
				last_push_error: "remote: Invalid username or password",
			},
		});
		const { container } = renderScreen();
		await screen.findByTestId("backup-health");

		const card = container.querySelector(".error-card") as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.textContent).not.toContain("gh auth switch");
		expect(card.textContent).toMatch(/SSH key or stored token/i);
		expect(card.textContent).toMatch(/How this machine signs in to GitHub/i);
	});

	it("hands over a real repo-creation link when gh cannot create one", async () => {
		mockBackup({
			backup_status: { ...okStatus, configured: false, initialized: false, last_commit: null },
			backup_auth_status: { ...okAuth, create_method: null },
		});
		renderScreen();
		// Not a grey sentence about a missing CLI — a button that opens GitHub.
		expect(await screen.findByTestId("backup-open-github-new")).toBeInTheDocument();
		expect(screen.getByTestId("backup-manual-create")).toHaveTextContent(/Private/);
	});
});

describe("BackupScreen — back up now", () => {
	it("runs a snapshot and reports the result", async () => {
		const user = userEvent.setup();
		const backupNow = vi.fn(async () => ({
			ok: true,
			committed: true,
			pushed: true,
			push_detail: "pushed to origin/main",
		}));
		mockBackup({ backup_now: backupNow });
		renderScreen();

		await user.click(await screen.findByRole("button", { name: /Back up now/i }));
		await waitFor(() => expect(backupNow).toHaveBeenCalled());
		expect(await screen.findByTestId("backup-result")).toHaveTextContent("pushed to origin/main");
	});

	it("reports a refused publish as a refusal rather than a success", async () => {
		const user = userEvent.setup();
		mockBackup({
			backup_now: {
				ok: false,
				committed: false,
				pushed: false,
				error: "credential-shaped string in skills/x/SKILL.md:3",
				error_kind: "secret_leak",
			},
		});
		renderScreen();
		await user.click(await screen.findByRole("button", { name: /Back up now/i }));
		expect(await screen.findByTestId("backup-result")).toHaveTextContent(/Refused to publish/);
	});

	it("renders a scrubbed error from the Rust layer verbatim — no token reconstruction", async () => {
		const user = userEvent.setup();
		// This is what the Rust scrubber produces: the token is already ***.
		mockBackup({
			backup_now: () => {
				throw new Error("git push failed: remote rejected credential *** for me/b.git");
			},
		});
		renderScreen();
		await user.click(await screen.findByRole("button", { name: /Back up now/i }));

		const toast = await screen.findByText(/git push failed/i);
		expect(toast).toHaveTextContent("***");
		expect(document.body.textContent).not.toMatch(/ghp_|github_pat_/);
	});
});

describe("BackupScreen — PAT handling", () => {
	it("never leaves the token in the DOM after submit", async () => {
		const user = userEvent.setup();
		const TOKEN = "github_pat_11ABCDEFG_supersecretvalue";
		const login = vi.fn(async () => ({ ...okAuth, stored: true }));
		mockBackup({ backup_auth_login_pat: login });
		renderScreen();

		await openCredentials(user);
		await user.click(await screen.findByTestId("open-pat-form"));
		const field = screen.getByLabelText(/Personal access token/i);
		// A password field so it is masked while being typed.
		expect(field).toHaveAttribute("type", "password");
		await user.type(field, TOKEN);

		await user.click(screen.getByRole("button", { name: /Store token/i }));

		// The token reaches the Tauri boundary exactly once, as the sole arg.
		await waitFor(() => expect(login).toHaveBeenCalledWith({ token: TOKEN }));
		// The form is gone, and the token appears nowhere: not in a value, not in
		// a toast, not in any text node.
		await waitFor(() => expect(screen.queryByTestId("pat-form")).not.toBeInTheDocument());
		expect(document.body.innerHTML).not.toContain(TOKEN);
	});

	/**
	 * The failure path is the dangerous one: an error thrown from anywhere that
	 * ISN'T the Rust scrubber (a rejected bridge call, a serialization error
	 * echoing its input) lands straight in a toast — and a toast is on screen,
	 * screen-shareable, and screen-recordable. The UI therefore scrubs what it
	 * renders rather than trusting the layer below it.
	 */
	it("scrubs a token-shaped string out of the failure toast", async () => {
		const user = userEvent.setup();
		const TOKEN = "ghp_failing1token2value3";
		mockBackup({
			backup_auth_login_pat: () => {
				// NOT pre-scrubbed — the token is echoed back raw.
				throw new Error(`keychain refused while storing ${TOKEN} for me/b.git`);
			},
		});
		renderScreen();

		await openCredentials(user);
		await user.click(await screen.findByTestId("open-pat-form"));
		await user.type(screen.getByLabelText(/Personal access token/i), TOKEN);
		await user.click(screen.getByRole("button", { name: /Store token/i }));

		// The toast still says what happened…
		const toast = toastOf(await screen.findByText(/Couldn't store the token/i));
		expect(toast).toHaveTextContent(/keychain refused/);
		// …with the credential replaced, not the whole message swallowed.
		expect(toast).toHaveTextContent("***");
		expect(toast.textContent).not.toContain(TOKEN);
		// And nowhere else in the document either (field cleared, no value attr).
		expect(document.body.innerHTML).not.toContain(TOKEN);
		expect(document.body.textContent).not.toMatch(/ghp_[A-Za-z0-9_]/);
	});

	it("scrubs a token-shaped string out of a failed backup toast too", async () => {
		const user = userEvent.setup();
		const TOKEN = "github_pat_11ABCDE_leakedvalue";
		mockBackup({
			backup_now: () => {
				throw new Error(`push rejected: https://x:${TOKEN}@github.com/me/b.git`);
			},
		});
		renderScreen();

		await user.click(await screen.findByRole("button", { name: /Back up now/i }));
		const toast = toastOf(await screen.findByText(/push rejected/i));
		expect(toast).toHaveTextContent("***");
		expect(document.body.innerHTML).not.toContain(TOKEN);
	});

	it("offers removal only when a token is actually stored", async () => {
		const user = userEvent.setup();
		renderScreen();
		await openCredentials(user);
		expect(await screen.findByTestId("logout-pat")).toBeInTheDocument();

		mockBackup({ backup_auth_status: { ...okAuth, pat_available: false } });
		const { container } = renderScreen();
		await waitFor(() =>
			expect(container.querySelector('[data-testid="logout-pat"]')).toBeNull(),
		);
	});
});

describe("BackupScreen — acknowledging a pending reconcile", () => {
	/** `backup status` before and after the acknowledge, so the banner can be
	 *  observed actually going away rather than merely being clicked. */
	function mockAcknowledgeable() {
		let pending = true;
		const calls: Record<string, unknown>[] = [];
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "backup_status") return { ...okStatus, pending_reconcile: pending };
			if (cmd === "backup_auth_status") return okAuth;
			if (cmd === "backup_now") {
				const a = (args ?? {}) as { acknowledgeRestore?: boolean };
				calls.push(a);
				// Mirrors hub.py: only `--acknowledge-restore` clears the flag.
				if (a.acknowledgeRestore) pending = false;
				return {
					ok: true,
					committed: true,
					pushed: !!a.acknowledgeRestore,
					push_detail: "pushed to origin/main",
					acknowledged_restore: !!a.acknowledgeRestore,
				};
			}
			return prev ? prev(cmd as never, args as never) : undefined;
		}) as never);
		return calls;
	}

	/**
	 * The button's entire job is the `--acknowledge-restore` flag. Without it the
	 * click runs an ordinary backup that commits, refuses to push, and leaves
	 * `pending_reconcile` exactly where it was — a control that looks like it
	 * worked and changed nothing.
	 */
	it("sends acknowledgeRestore to the CLI and clears the banner", async () => {
		const user = userEvent.setup();
		const calls = mockAcknowledgeable();
		renderScreen();

		await user.click(await screen.findByTestId("acknowledge-restore"));

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({ acknowledgeRestore: true });

		// The banner is gone because the STATUS changed, not because the button
		// hid itself optimistically.
		await waitFor(() =>
			expect(screen.queryByTestId("pending-reconcile-banner")).not.toBeInTheDocument(),
		);
	});

	/**
	 * Plain "Back up now" cannot push while a reconcile is pending — only
	 * `--acknowledge-restore` can. It used to sit in the header as the screen's
	 * one VIOLET button, i.e. the working action was the ghost and the primary
	 * was the no-op. It is now inert, visible, and says why.
	 */
	it("offers no working 'Back up now' while a restore is pending", async () => {
		const user = userEvent.setup();
		const calls = mockAcknowledgeable();
		renderScreen();
		await screen.findByTestId("pending-reconcile-banner");

		const paused = screen.getByTestId("backup-now-paused");
		expect(paused).toHaveAttribute("aria-disabled", "true");
		expect(paused.getAttribute("title")).toMatch(/paused/i);

		await user.click(paused);
		// A click on it publishes nothing at all.
		expect(calls.length).toBe(0);
		expect(screen.getByTestId("pending-reconcile-banner")).toBeInTheDocument();
	});
});

describe("BackupScreen — a refused publish", () => {
	const slot = {
		ran: true,
		skipped: null,
		committed: false,
		pushed: false,
		conflict: false,
		error: "credential-shaped string in skills/deploy/SKILL.md:3 (sha256 4f21ab…)",
		error_kind: "secret_leak",
		at: "2026-08-04T09:00:00Z",
	};

	function withSyncReportSlot(backupSlot: unknown) {
		mockBackup({
			sync_report: {
				report: {
					schema_version: 1,
					generated_at: "2026-08-04T09:00:00Z",
					registry_sha256: "abc",
					registry_mtime: 1,
					ok: true,
					global: { backup: backupSlot },
					projects: {},
				},
				registry_current: { sha256: "abc", mtime: 1 },
			},
		});
	}

	/**
	 * The dead end this closes: the StatusBar chip escalates on the sync
	 * report's slot, but the screen it linked to only ever read `backup status`
	 * — so "backup refused" routed to a page showing a healthy repo and a
	 * "Retry backup" button that would refuse again, identically.
	 */
	it("explains what was refused and how to clear it, from the sync-report slot", async () => {
		withSyncReportSlot(slot);
		renderScreen();

		const card = await screen.findByTestId("backup-refused");
		expect(card).toHaveTextContent(/nothing was published/i);
		// The finding, verbatim.
		expect(card).toHaveTextContent("skills/deploy/SKILL.md:3");
		// Both remedies, named as commands.
		expect(card).toHaveTextContent("hub backup now");
		expect(card).toHaveTextContent("--allow-secret");
		// A retry would refuse identically — it must not be offered as the fix.
		expect(screen.queryByRole("button", { name: /Retry backup/i })).not.toBeInTheDocument();
	});

	it("distinguishes a prefix leak from a secret leak", async () => {
		withSyncReportSlot({ ...slot, error_kind: "prefix_leak", error: "home prefix in state/x.json" });
		renderScreen();
		expect(await screen.findByTestId("backup-refused")).toHaveTextContent(/path prefix/i);
	});

	/** Forward-compat: `backup status --json` is growing its own `error_kind`.
	 *  Either source must raise the card — neither may be required. */
	it("also reads the refusal off backup status alone (no sync report)", async () => {
		mockBackup({
			backup_status: {
				...okStatus,
				error_kind: "secret_leak",
				last_error: "credential-shaped string in snippets/a.md:12",
			},
		});
		renderScreen();
		const card = await screen.findByTestId("backup-refused");
		expect(card).toHaveTextContent("snippets/a.md:12");
	});

	it("stays quiet when the last run was an ordinary success", async () => {
		withSyncReportSlot({ ...slot, error: null, error_kind: null, pushed: true, committed: true });
		renderScreen();
		await screen.findByText("git@github.com:me/skill-tree-backup.git");
		expect(screen.queryByTestId("backup-refused")).not.toBeInTheDocument();
	});
});

/** Renders the live URL + a palette-equivalent trigger, so the auto-run
 *  lifecycle can be asserted on both the URL and the re-invocation. */
function Probe() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<span data-testid="url">{`${location.pathname}${location.search}`}</span>
			<button
				data-testid="palette-backup-now"
				onClick={() => navigate("/backup", { state: { backupNow: true } })}
			>
				palette: back up now
			</button>
		</>
	);
}

describe("BackupScreen — the palette's auto-run", () => {
	function countBackupNow() {
		const calls: unknown[] = [];
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "backup_now") {
				calls.push(args);
				return { ok: true, committed: true, pushed: true, push_detail: "pushed" };
			}
			return prev ? prev(cmd as never, args as never) : undefined;
		}) as never);
		return calls;
	}

	function renderAt(route: string | { pathname: string; search?: string; state?: unknown }) {
		return renderWithProviders(
			<>
				<Probe />
				<BackupScreen />
				<ToastContainer />
			</>,
			{ initialRoute: route },
		);
	}

	/** The param must not be able to survive to a reload, so it is stripped on
	 *  the mount decision — not after `backup_status` finally resolves. */
	it("strips ?now=1 immediately, before the status query has resolved", async () => {
		const gate = deferredInvoke((cmd) => cmd === "backup_status");
		renderAt({ pathname: "/backup", search: "?now=1" });

		await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent("/backup"));
		expect(screen.getByTestId("url").textContent).not.toContain("now=1");
		gate.resolve(okStatus);
	});

	/** An unattended reload of a stale URL must never publish a snapshot. */
	it("never fires a push from the URL alone", async () => {
		const calls = countBackupNow();
		renderAt({ pathname: "/backup", search: "?now=1" });

		await screen.findByText("git@github.com:me/skill-tree-backup.git");
		// Give the status query + both effects room to settle.
		await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent("/backup"));
		expect(calls).toHaveLength(0);
	});

	it("runs once when the palette hands it over in navigation state", async () => {
		const calls = countBackupNow();
		renderAt({ pathname: "/backup", state: { backupNow: true } });

		await waitFor(() => expect(calls).toHaveLength(1));
		// …and does not repeat on subsequent re-renders.
		await screen.findByTestId("backup-result");
		expect(calls).toHaveLength(1);
	});

	it("re-triggers on a second palette invocation while already on the screen", async () => {
		const user = userEvent.setup();
		const calls = countBackupNow();
		renderAt("/backup");

		await screen.findByText("git@github.com:me/skill-tree-backup.git");
		await user.click(screen.getByTestId("palette-backup-now"));
		await waitFor(() => expect(calls).toHaveLength(1));

		await user.click(screen.getByTestId("palette-backup-now"));
		await waitFor(() => expect(calls).toHaveLength(2));
	});
});

describe("BackupScreen — enable/disable", () => {
	it("toggles automatic backup through the dedicated commands", async () => {
		const user = userEvent.setup();
		const disable = vi.fn(async () => ({ ok: true, enabled: false }));
		mockBackup({ backup_disable: disable });
		renderScreen();

		const toggle = await screen.findByLabelText(/Automatic backup after each sync/i);
		await user.click(toggle);
		await waitFor(() => expect(disable).toHaveBeenCalled());
	});
});
