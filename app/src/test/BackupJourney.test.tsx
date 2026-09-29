
import { readAppCss } from "./readAppCss";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { BackupScreen } from "@/screens/BackupScreen";
import { BootstrapBackupStep } from "@/components/backup/BootstrapBackupStep";
import { ToastContainer } from "@/components/Toast";
import { renderWithProviders } from "@/test/helpers";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(async () => {}),
	openPath: vi.fn(async () => {}),
	revealItemInDir: vi.fn(async () => {}),
}));

/**
 * The guided journey, as behaviour.
 *
 * What this file pins is the fix for the reported first-use failure: a user with
 * working credentials landed on /backup and had **no visible way to start**. The
 * assertions below are therefore about *direction*, not decoration — which stage
 * is live, that exactly one violet primary exists at a time, that every dead
 * credential row carries a verb, and that nothing on these screens says
 * "skill-hub" at a user.
 */

const FRESH_STATUS = {
	enabled: true,
	initialized: false,
	configured: false,
	dir: "~/.skill-hub-backup",
	remote: null,
	repo: null,
	branch: null,
	auth: {
		configured: "auto",
		pat_available: true,
		pat_detail: "token stored in your OS keychain",
		gh_login: "me",
		gh_active_login: "me",
		gh_account_mismatch: false,
	},
	push_failures: 0,
	last_push_error: null,
	pending_reconcile: false,
	last_commit: null,
	ahead: null,
	behind: null,
	drift: "unknown",
	manifest: null,
	warnings: [],
};

const WORKING_AUTH = {
	method: "ssh",
	configured: "auto",
	ladder: [
		{ method: "ssh", available: true, detail: "authenticated to github.com as me", user: "me" },
		{ method: "gh", available: false, detail: "gh CLI not installed", user: null },
		{
			method: "pat",
			available: true,
			detail: "token stored in your OS keychain",
			user: null,
			ref: "skill-hub:github-backup",
		},
	],
	keyring_available: true,
	pat_available: true,
	pat_ref: "skill-hub:github-backup",
	pat_detail: "token stored in your OS keychain",
	gh_login: null,
	create_method: null,
	ok: true,
};

const NO_AUTH = {
	...WORKING_AUTH,
	method: null,
	pat_available: false,
	pat_ref: null,
	ladder: [
		{
			method: "ssh",
			available: false,
			detail: "git@github.com: Permission denied (publickey).",
			user: null,
		},
		{ method: "gh", available: false, detail: "gh CLI not installed", user: null },
		{ method: "pat", available: false, detail: "no token stored yet", user: null },
	],
};

function mockBackup(over: Record<string, unknown> = {}) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd in over) {
			const v = over[cmd];
			return typeof v === "function" ? (v as (a?: unknown) => unknown)(args) : v;
		}
		if (cmd === "backup_status") return FRESH_STATUS;
		if (cmd === "backup_auth_status") return WORKING_AUTH;
		return prev ? prev(cmd as never, args as never) : undefined;
	}) as never);
}

function renderScreen() {
	return renderWithProviders(
		<>
			<BackupScreen />
			<ToastContainer />
		</>,
	);
}

/** Every violet primary currently on screen. `Button variant="primary"` is the
 *  ONE brand-accented control (COMPONENTS.md §Accents), so counting the class is
 *  counting the promise. */
function primaries(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>("button.btn-primary"));
}

beforeEach(() => mockBackup());

describe("Backup journey — stages", () => {
	it("renders all three stages with the repository stage live for a credentialed user", async () => {
		renderScreen();
		await screen.findByTestId("backup-journey");

		expect(screen.getByTestId("backup-stage-credential")).toHaveAttribute("data-state", "done");
		expect(screen.getByTestId("backup-stage-repository")).toHaveAttribute("data-state", "current");
		expect(screen.getByTestId("backup-stage-first-backup")).toHaveAttribute("data-state", "todo");
	});

	/** The reported failure, as an assertion: from the state the product owner was
	 *  in, there is a visible, enabled way to proceed. */
	it("offers a repository field and a primary action, not just status rows", async () => {
		renderScreen();
		expect(await screen.findByTestId("backup-repo-input")).toBeInTheDocument();
		expect(screen.getByTestId("backup-init")).toBeInTheDocument();
	});

	/** A bare `me/skill-tree-backup` sitting in an empty field reads as a value
	 *  that is already filled in, so people tabbed past it and then found the
	 *  primary dead with no explanation. */
	it("marks the repo placeholder as an example, not a prefilled value", async () => {
		renderScreen();
		const input = await screen.findByTestId("backup-repo-input");
		expect(input).toHaveValue("");
		expect(input.getAttribute("placeholder")).toMatch(/^e\.g\. /);
	});

	/** The field takes `owner/name`. Pasting a clone URL — the mistake people
	 *  actually make here — used to arm the primary and fail on submit. */
	it("keeps the primary inert until the repo field validates, and says why", async () => {
		const user = userEvent.setup();
		renderScreen();
		const input = await screen.findByTestId("backup-repo-input");
		const init = screen.getByTestId("backup-init");

		expect(init).toHaveAttribute("aria-disabled", "true");

		await user.type(input, "git@github.com:me/b.git");
		expect(init).toHaveAttribute("aria-disabled", "true");
		expect(init.getAttribute("title")).toMatch(/clone URL/i);
		expect(await screen.findByText(/clone URL/i)).toBeInTheDocument();

		await user.clear(input);
		await user.type(input, "me/skill-tree-backup");
		await waitFor(() => expect(init).not.toHaveAttribute("aria-disabled"));
		expect(screen.queryByText(/clone URL/i)).not.toBeInTheDocument();
	});

	it("keeps exactly one violet primary on screen while setting up", async () => {
		const { container } = renderScreen();
		await screen.findByTestId("backup-journey");
		expect(primaries(container)).toHaveLength(1);
		expect(primaries(container)[0]).toHaveAttribute("data-testid", "backup-init");
	});

	it("moves the single primary to the snapshot once a repo is configured", async () => {
		mockBackup({
			backup_status: { ...FRESH_STATUS, configured: true, initialized: true, repo: "me/x" },
		});
		const { container } = renderScreen();
		await screen.findByTestId("backup-journey");

		expect(screen.getByTestId("backup-stage-first-backup")).toHaveAttribute(
			"data-state",
			"current",
		);
		const ps = primaries(container);
		expect(ps).toHaveLength(1);
		expect(ps[0]).toHaveAttribute("data-testid", "backup-first-run");
	});

	it("leads with the credential stage when nothing can push", async () => {
		mockBackup({ backup_auth_status: NO_AUTH });
		renderScreen();
		await screen.findByTestId("backup-journey");
		expect(screen.getByTestId("backup-stage-credential")).toHaveAttribute("data-state", "current");
		expect(screen.getByTestId("backup-stage-repository")).toHaveAttribute("data-state", "todo");
	});

	/**
	 * The dead end: with no credential the screen showed a banner reading "You
	 * can still continue — snapshots will be committed on this machine" above a
	 * collapsed stage 2, so there was nothing to continue WITH. The repo stage
	 * never depended on a credential; it was collapsed for being second in a
	 * list.
	 *
	 * Asserted through the CONTROLS, not the open flag: what was missing was the
	 * field and its two buttons, and a `data-open` attribute could go true while
	 * they stayed absent.
	 */
	it("keeps the repo stage usable while no credential works", async () => {
		const user = userEvent.setup();
		mockBackup({ backup_auth_status: NO_AUTH });
		renderScreen();
		await screen.findByTestId("backup-journey");

		expect(screen.getByTestId("backup-stage-repository")).toHaveAttribute("data-open", "true");
		const input = screen.getByTestId("backup-repo-input");
		expect(input).toBeInTheDocument();
		// The way out of the state — creating the repo — is reachable too.
		expect(screen.getByTestId("backup-open-github-new")).toBeInTheDocument();

		// And it genuinely works: typing a repo arms `Use this repository`.
		const use = screen.getByTestId("backup-init");
		expect(use).toHaveAttribute("aria-disabled", "true");
		await user.type(input, "me/skill-tree-backup");
		expect(use).not.toHaveAttribute("aria-disabled");
	});

	/**
	 * Two stages are live in this state (fix the credential, or name a repo and
	 * carry on locally), which is honest — but each card still offers exactly one
	 * emphasised way forward. Two violet buttons inside one card is the "no
	 * primary" disease; one per card is a ranked choice.
	 */
	it("keeps at most one primary per stage card with no credential", async () => {
		const user = userEvent.setup();
		mockBackup({ backup_auth_status: NO_AUTH });
		const { container } = renderScreen();
		await screen.findByTestId("backup-journey");
		await user.type(screen.getByTestId("backup-repo-input"), "me/skill-tree-backup");

		for (const id of ["credential", "repository", "first-backup"]) {
			const card = screen.getByTestId(`backup-stage-${id}`);
			expect(card.querySelectorAll("button.btn-primary").length).toBeLessThanOrEqual(1);
		}
		// The ladder's own primary is the recommended rung, not one of the others.
		expect(
			within(screen.getByTestId("backup-stage-credential")).getByTestId("rung-fix-ssh"),
		).toHaveClass("btn-primary");
		expect(primaries(container).length).toBe(2);
	});

	/** The one stage with a real prerequisite stays shut: there is nowhere to
	 *  push a first snapshot until a repo is named. */
	it("still gates the snapshot stage on a repo existing", async () => {
		mockBackup({ backup_auth_status: NO_AUTH });
		renderScreen();
		await screen.findByTestId("backup-journey");
		expect(screen.getByTestId("backup-stage-first-backup")).toHaveAttribute("data-open", "false");
		expect(screen.queryByTestId("backup-first-run")).not.toBeInTheDocument();
	});

	it("configures the repo through backup_init and celebrates the first snapshot", async () => {
		const user = userEvent.setup();
		const init = vi.fn(async () => ({ ok: true, warnings: [] }));
		let configured = false;
		mockBackup({
			backup_status: () => ({
				...FRESH_STATUS,
				configured,
				initialized: configured,
				repo: configured ? "me/skill-tree-backup" : null,
			}),
			backup_init: () => {
				configured = true;
				return init();
			},
			backup_now: {
				ok: true,
				committed: true,
				pushed: true,
				push_detail: "pushed to origin/main",
				counts: { skills: 12, mcp_servers: 1 },
			},
		});
		renderScreen();

		await user.type(await screen.findByTestId("backup-repo-input"), "me/skill-tree-backup");
		await user.click(screen.getByTestId("backup-init"));
		await waitFor(() => expect(init).toHaveBeenCalled());

		// Stage 3 becomes the live one — the journey does not end at "configured".
		const first = await screen.findByTestId("backup-first-run");
		await user.click(first);

		const party = await screen.findByTestId("backup-celebrate");
		expect(party).toHaveTextContent(/pushed/i);
		// It says what was actually captured, rather than a bare "done".
		expect(party).toHaveTextContent("12 skills");
	});

	it("switches to the health layout only once a snapshot exists", async () => {
		mockBackup({
			backup_status: {
				...FRESH_STATUS,
				configured: true,
				initialized: true,
				repo: "me/skill-tree-backup",
				remote: "git@github.com:me/skill-tree-backup.git",
				drift: "in-sync",
				last_commit: { sha: "9f2c1ab77e40d3b1", ts: "2026-08-04T09:12:44Z", subject: "snapshot" },
			},
		});
		renderScreen();
		expect(await screen.findByTestId("backup-health")).toBeInTheDocument();
		expect(screen.queryByTestId("backup-journey")).not.toBeInTheDocument();
		// Maintenance is one click away, not in the way.
		expect(screen.getByTestId("backup-credential-disclosure")).toBeInTheDocument();
		expect(screen.getByTestId("backup-restore-disclosure")).toBeInTheDocument();
		expect(screen.queryByTestId("restore-danger-zone")).not.toBeInTheDocument();
	});
});

describe("Backup — one violet action, always", () => {
	/**
	 * COMPONENTS.md §Accents: violet is the ONE brand/primary channel, and a
	 * screen showing two primaries has no primary. The subtler failure this
	 * guards is which one it is: while a reconcile is pending, plain "Back up
	 * now" cannot push, so making IT the violet button left the working action
	 * ("Acknowledge & back up") looking like the secondary one.
	 */
	it("gives the one violet action to the only thing that can push", async () => {
		mockBackup({
			backup_status: {
				...FRESH_STATUS,
				configured: true,
				initialized: true,
				repo: "me/skill-tree-backup",
				remote: "git@github.com:me/skill-tree-backup.git",
				pending_reconcile: true,
				last_commit: { sha: "9f2c1ab77e40d3b1", ts: "2026-08-04T09:12:44Z", subject: "snapshot" },
			},
		});
		const { container } = renderScreen();
		expect(await screen.findByTestId("pending-reconcile-banner")).toBeInTheDocument();
		expect(primaries(container)).toHaveLength(1);
		expect(primaries(container)[0]).toHaveTextContent(/Acknowledge/i);
		expect(primaries(container)[0]).toHaveAttribute("data-testid", "acknowledge-restore");
	});

	/** An error card owns the retry; a second violet button in the header splits
	 *  the eye at exactly the moment there is one thing to do. */
	it("demotes the header action while an error card owns the primary", async () => {
		mockBackup({
			backup_status: {
				...FRESH_STATUS,
				configured: true,
				initialized: true,
				repo: "me/skill-tree-backup",
				remote: "git@github.com:me/skill-tree-backup.git",
				push_failures: 4,
				last_push_error: "remote: Invalid username or password",
				last_commit: { sha: "9f2c1ab77e40d3b1", ts: "2026-08-04T09:12:44Z", subject: "snapshot" },
			},
		});
		const { container } = renderScreen();
		await screen.findByTestId("backup-health");
		expect(primaries(container)).toHaveLength(1);
		expect(primaries(container)[0]).toHaveAttribute("data-testid", "backup-retry");
	});
});

describe("Backup — progressive disclosure never hides a problem", () => {
	const CONFIGURED = {
		...FRESH_STATUS,
		configured: true,
		initialized: true,
		repo: "me/skill-tree-backup",
		remote: "git@github.com:me/skill-tree-backup.git",
		last_commit: { sha: "9f2c1ab77e40d3b1", ts: "2026-08-04T09:12:44Z", subject: "snapshot" },
	};

	/**
	 * The signals worth auto-opening for arrive with an ASYNC query, so a
	 * `defaultOpen` read once at mount is `false` on every cold load — the
	 * section would collapse over a live problem. Openness is derived until the
	 * user touches the control.
	 */
	it("opens the credential section by itself when the gh account is wrong", async () => {
		mockBackup({
			backup_status: {
				...CONFIGURED,
				auth: { ...CONFIGURED.auth, gh_active_login: "other", gh_account_mismatch: true },
			},
		});
		renderScreen();
		expect(await screen.findByTestId("gh-account-mismatch")).toBeVisible();
	});

	it("opens it when no credential works at all", async () => {
		mockBackup({ backup_status: CONFIGURED, backup_auth_status: NO_AUTH });
		renderScreen();
		expect(await screen.findByTestId("auth-rung-ssh")).toBeVisible();
	});

	it("stays collapsed — and closable — when everything is fine", async () => {
		const user = userEvent.setup();
		mockBackup({ backup_status: CONFIGURED });
		renderScreen();
		await screen.findByTestId("backup-health");
		expect(screen.queryByTestId("auth-rung-ssh")).not.toBeInTheDocument();

		await user.click(screen.getByTestId("backup-credential-disclosure"));
		expect(await screen.findByTestId("auth-rung-ssh")).toBeVisible();
		await user.click(screen.getByTestId("backup-credential-disclosure"));
		expect(screen.queryByTestId("auth-rung-ssh")).not.toBeInTheDocument();
	});
});

describe("Backup journey — the gh row is an enhancement, not a dead end", () => {
	/** A satisfied credential stage collapses; `Change` is how the ladder comes
	 *  back. That reopening is itself part of the contract — a done stage must
	 *  never be a locked one. */
	async function openLadder(user: ReturnType<typeof userEvent.setup>) {
		await screen.findByTestId("backup-journey");
		const change = screen.queryByTestId("backup-stage-change-credential");
		if (change) await user.click(change);
	}

	it("labels gh optional and hands over a copyable install command", async () => {
		const user = userEvent.setup();
		renderScreen();
		await openLadder(user);
		const row = await screen.findByTestId("auth-rung-gh");
		expect(row).toHaveAttribute("data-optional", "true");
		expect(row).toHaveTextContent(/optional/i);
		expect(row).toHaveTextContent("brew install gh");
		// BOTH commands are copyable, never auto-run — the app does not invoke
		// package managers. `gh auth login` used to render in the identical chip
		// style with no copy button, so the command more easily fumbled by hand
		// was the one you had to type.
		expect(within(row).getByTitle(/Copy “brew install gh”/)).toBeInTheDocument();
		expect(within(row).getByTitle(/Copy “gh auth login”/)).toBeInTheDocument();
	});

	it("copies the install command to the clipboard rather than executing it", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		// AFTER `setup()`: userEvent installs its own clipboard stub, so a spy
		// planted before it would be the one that gets overwritten.
		const user = userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		renderScreen();
		await openLadder(user);

		const row = await screen.findByTestId("auth-rung-gh");
		await user.click(within(row).getByTitle(/Copy “brew install gh”/));
		expect(writeText).toHaveBeenCalledWith("brew install gh");
		await user.click(within(row).getByTitle(/Copy “gh auth login”/));
		expect(writeText).toHaveBeenCalledWith("gh auth login");
	});

	/** When NOTHING works, every row must name its own concrete fix — this is
	 *  the state where "gh CLI not installed" used to be the whole story. */
	it("gives every dead rung a fix action when no credential works", async () => {
		mockBackup({ backup_auth_status: NO_AUTH });
		renderScreen();
		await screen.findByTestId("backup-journey");

		expect(await screen.findByTestId("rung-fix-ssh")).toBeInTheDocument();
		expect(screen.getByTestId("rung-fix-gh")).toBeInTheDocument();
		expect(screen.getByTestId("rung-fix-pat")).toBeInTheDocument();
		// …and none of them is labelled optional, because none of them is.
		expect(screen.getByTestId("auth-rung-ssh")).not.toHaveAttribute("data-optional");
	});

	/**
	 * Three dead rungs with three identically-weighted ghost remedies read as
	 * three equally-required chores with no way in. "Used for push" and
	 * "optional" are both false of every row in this state, so the ranking has
	 * to come from somewhere that is true: SSH is the rung the ladder calls the
	 * push credential, so it takes the one emphasised button and the badge.
	 */
	it("ranks one remedy as the primary when nothing works at all", async () => {
		mockBackup({ backup_auth_status: NO_AUTH });
		renderScreen();
		await screen.findByTestId("backup-journey");

		expect(await screen.findByTestId("rung-fix-ssh")).toHaveClass("btn-primary");
		expect(screen.getByTestId("rung-fix-pat")).not.toHaveClass("btn-primary");
		expect(screen.getByTestId("auth-rung-ssh")).toHaveTextContent(/start here/i);
		expect(screen.getByTestId("auth-rung-gh")).not.toHaveTextContent(/start here/i);
	});

	/** …and never once something already pushes: then "optional" is the honest
	 *  word, and the row that matters is the one marked used-for-push. */
	it("recommends nothing while a credential already works", async () => {
		const user = userEvent.setup();
		mockBackup({ backup_auth_status: WORKING_AUTH });
		renderScreen();
		await screen.findByTestId("backup-journey");
		// The stage is `done`, so the ladder lives behind its own Change button.
		await user.click(screen.getByTestId("backup-stage-change-credential"));

		const ssh = await screen.findByTestId("auth-rung-ssh");
		expect(ssh).not.toHaveTextContent(/start here/i);
		expect(ssh).toHaveTextContent(/used for push/i);
		expect(screen.getByTestId("auth-rung-gh")).toHaveTextContent(/optional/i);
	});

	it("does not offer the token form when token storage itself is unavailable", async () => {
		mockBackup({
			backup_auth_status: {
				...NO_AUTH,
				keyring_available: false,
				pat_detail: "the `keyring` package is not installed",
			},
		});
		renderScreen();
		await screen.findByTestId("auth-rung-pat");
		expect(screen.queryByTestId("rung-fix-pat")).not.toBeInTheDocument();
	});
});

describe("Backup journey — the restore fork", () => {
	it("offers restore as an alternative first step on a fresh machine", async () => {
		const user = userEvent.setup();
		renderScreen();

		const fork = await screen.findByTestId("backup-restore-fork");
		expect(fork).toHaveTextContent(/already have a backup/i);
		// Hidden until asked for, so it never competes with the setup journey.
		expect(screen.queryByTestId("restore-danger-zone")).not.toBeInTheDocument();

		await user.click(screen.getByTestId("backup-restore-fork-toggle"));
		expect(await screen.findByTestId("restore-danger-zone")).toBeInTheDocument();
	});

	/** The expanded form lands below the fold at narrow widths, where clicking
	 *  the toggle otherwise looks like it did nothing. */
	it("scrolls the expanded form into view", async () => {
		const user = userEvent.setup();
		// `setup.ts` stubs this on HTMLElement.prototype (jsdom has no layout), so
		// the spy must replace THAT — a patch on Element.prototype is shadowed.
		const scrollIntoView = vi.fn();
		const prev = window.HTMLElement.prototype.scrollIntoView;
		window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
		try {
			renderScreen();
			await screen.findByTestId("backup-restore-fork");
			await user.click(screen.getByTestId("backup-restore-fork-toggle"));
			await screen.findByTestId("restore-danger-zone");
			expect(scrollIntoView).toHaveBeenCalled();
		} finally {
			window.HTMLElement.prototype.scrollIntoView = prev;
		}
	});

	/**
	 * Red is the status channel's error/danger endpoint. It belongs on the
	 * destructive CONFIRM — the typed-word dialog and its danger button — not on
	 * a form whose only action is a dry-run preview. A permanently-red panel is a
	 * panel whose red has stopped meaning anything.
	 *
	 * Asserted against the stylesheet SOURCE: jsdom does not apply `App.css`, so
	 * a computed-style check here would pass no matter what the border is.
	 */
	it("frames the form neutrally — red is saved for the confirm", () => {
		// vitest runs with cwd = app/; `import.meta.url` is a Vite virtual path here.
		const css = readAppCss();
		const block = css.slice(css.indexOf("\n.restore-zone {"));
		const rule = block.slice(0, block.indexOf("}"));
		expect(rule).toContain("border:");
		expect(rule).not.toContain("--red");
	});

	/**
	 * The `gh auth switch--user me` / `lsp_report.py--advisory` defect, at its
	 * real cause.
	 *
	 * The DOM string was always right — every text assertion passed while the
	 * screen painted a command that does not exist. Geist Mono's contextual
	 * alternates shape `<space>--` into one connected dash and drop the space's
	 * cell with it, so this can only be pinned in the stylesheet.
	 *
	 * Pinned at the ROOT, not on a class list: round 2 scoped the kill to
	 * `.cred-cmd` / `.error-card .cmd`, and the very next frame shipped a mangled
	 * hook command in the restore consent dialog. "Every place a command can
	 * appear" is a list that goes stale the moment someone adds a screen, so the
	 * final assertion fails if the declaration is ever re-scoped to a selector
	 * instead of inherited from `:root`.
	 */
	it("kills mono ligatures at the root, so no mono context can reshape a flag", () => {
		const css = readAppCss();
		const at = css.indexOf("\n:root {\n  font-variant-ligatures: none;");
		expect(at).toBeGreaterThan(-1);
		const rule = css.slice(at, css.indexOf("}", at));
		expect(rule).toContain("font-variant-ligatures: none");
		expect(rule).toContain('"calt" 0');
		expect(rule).toContain('"liga" 0');
		expect(rule).toContain('"dlig" 0');
		// No class selector may narrow this back down to a hand-kept list.
		expect(css).not.toMatch(/^\.[^{}\n]*\{[^{}]*font-variant-ligatures: none/m);
	});

	/** House voice: "harness" is the sync target, never "agent". */
	it("says harnesses, not agents, for the sync targets", async () => {
		const user = userEvent.setup();
		renderScreen();
		await screen.findByTestId("backup-restore-fork");
		await user.click(screen.getByTestId("backup-restore-fork-toggle"));
		const zone = await screen.findByTestId("restore-danger-zone");
		expect(zone.textContent).toMatch(/into your harnesses/i);
		expect(zone.textContent).not.toMatch(/into your agents/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Naming
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the user can read, with the mono identifiers of real paths left
 *  alone: `~/.skill-hub-backup` and the keychain handle are functional names we
 *  deliberately keep, so the guard looks at rendered TEXT and exempts them. */
function userVisibleText(container: HTMLElement): string {
	return (container.textContent ?? "")
		// The two identifiers that must NOT be renamed (back-compat: the default
		// backup dir on disk, and the keychain service holding existing tokens).
		.replace(/~\/\.skill-hub-backup/g, "")
		.replace(/~\/\.skill-hub\b/g, "")
		.replace(/skill-hub:github-backup/g, "");
}

describe("Backup surfaces say Skill Tree, never skill-hub", () => {
	it("on the unconfigured setup journey", async () => {
		const { container } = renderScreen();
		await screen.findByTestId("backup-journey");
		expect(userVisibleText(container)).not.toMatch(/skill-hub/i);
		expect(container.textContent).toContain("Skill Tree");
	});

	it("on the configured screen with every section opened", async () => {
		const user = userEvent.setup();
		mockBackup({
			backup_status: {
				...FRESH_STATUS,
				configured: true,
				initialized: true,
				repo: "me/skill-tree-backup",
				remote: "git@github.com:me/skill-tree-backup.git",
				branch: "main",
				drift: "in-sync",
				last_commit: { sha: "9f2c1ab77e40d3b1", ts: "2026-08-04T09:12:44Z", subject: "snapshot" },
			},
		});
		const { container } = renderScreen();
		await user.click(await screen.findByTestId("backup-credential-disclosure"));
		await user.click(screen.getByTestId("backup-restore-disclosure"));
		await user.click(screen.getByTestId("open-pat-form"));

		expect(userVisibleText(container)).not.toMatch(/skill-hub/i);
	});

	it("on the bootstrap backup step", async () => {
		const { container } = renderWithProviders(
			<BootstrapBackupStep onDone={() => {}} onSkip={() => {}} />,
		);
		await screen.findByTestId("bootstrap-stage-repository");
		expect(userVisibleText(container)).not.toMatch(/skill-hub/i);
		expect(container.textContent).toContain("Skill Tree");
	});

	/** Placeholders are copy too — `me/skill-hub-backup` was the suggestion the
	 *  screen made to every new user. */
	it("suggests skill-tree-backup in every placeholder", async () => {
		const { container } = renderScreen();
		await screen.findByTestId("backup-repo-input");
		const placeholders = Array.from(container.querySelectorAll("input"))
			.map((i) => i.getAttribute("placeholder") ?? "")
			.join(" ");
		expect(placeholders).not.toMatch(/skill-hub/);
	});
});
