import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { BootstrapWizard, type BootstrapState } from "@/screens/BootstrapWizard";
import { ToastContainer } from "@/components/Toast";
import { renderWithProviders } from "@/test/helpers";
import { Processes } from "@/store/processes";
import { RESTORE_MODE_LABELS } from "@/lib/backupContract";

/**
 * Restore-first ordering (design §9).
 *
 * The load-bearing claim is a NEGATIVE one: choosing "Restore from backup" must
 * never run the import wizard's commands. Running an import scan before a
 * restore would manufacture conflicts against the very skills the restore is
 * about to lay down, so this suite asserts `bootstrap_run` is never invoked on
 * the restore path — and that the restore path is reachable before any scanning
 * UI is shown at all.
 */

/** Commands that belong exclusively to the import branch. */
const IMPORT_COMMANDS = ["bootstrap_run"];

const state: BootstrapState = {
	needs_bootstrap: true,
	completed_at: null,
	version: 1,
	legacy_detected: [],
	data_home: "/home/test/.skill-hub",
	code_home: "/home/test/code/skill-hub",
	candidates: [
		{
			origin: "claude-code",
			name: "brainstorm",
			path: "/home/test/.claude/skills/brainstorm",
			category: "NEW",
		},
	],
	conflicts: [],
	blocked: [],
	already_managed: [],
	silent_skip: [],
};

/** A trimmed capture of the real `hub restore --json` payload (see
 *  `backupContract.test.ts` for the field-by-field pins). */
const plan = {
	ok: false, // consent-gated: executable state is not yet accepted
	fatal: false,
	apply: false,
	source: "git@github.com:me/b.git",
	mode: "replace",
	integrity: {
		tree_digest: { ok: true, detail: "tree digest matches" },
		trust: {
			state: "verified",
			ok: true,
			hard: false,
			detail: "signed by the key pinned for this source",
			key_id: "SHA256:aaaa1111",
			pinned_key_id: "SHA256:aaaa1111",
		},
		ok: true,
	},
	registry: {
		target_populated: false,
		mode_required: false,
		diff: {
			sections: { projects: { added: [], lost: ["scratch"], conflicts: [] } },
			top_level_added: [],
			top_level_lost: [],
			totals: { added: 0, lost: 1, conflicts: 0 },
		},
	},
	projects: [],
	subagents: [
		{
			harness: "claude-code",
			name: "reviewer.md",
			target: "~/.claude/agents/reviewer.md",
			action: "write",
			detail: "not present on this machine",
		},
	],
	global_docs: [],
	executable_state: {
		hooks: [{ name: "fmt", event: "PostToolUse", command: "/bin/fmt.sh --all", broken: false }],
		permission_rules: [],
		codex_trust: [],
		any: true,
		broken_hooks: [],
		accepted: false,
		requires_consent: true,
	},
	warnings: [],
	errors: ["this snapshot installs executable state (1 hook(s), 0 permission rule(s), …"],
	next_steps: ["review the restored registry, then run `hub sync`"],
};

let calls: string[] = [];

function mockBootstrap(over: Record<string, unknown> = {}) {
	calls = [];
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		calls.push(cmd);
		if (cmd in over) {
			const v = over[cmd];
			return typeof v === "function" ? (v as (a?: unknown) => unknown)(args) : v;
		}
		if (cmd === "restore_preview" || cmd === "restore_apply") return plan;
		return prev ? prev(cmd as never, args as never) : undefined;
	}) as never);
}

function renderWizard() {
	return renderWithProviders(
		<>
			<BootstrapWizard state={state} />
			<ToastContainer />
		</>,
	);
}

beforeEach(() => mockBootstrap());

describe("BootstrapWizard — first decision stage", () => {
	it("opens on the fresh-vs-restore choice, NOT on the import list", async () => {
		renderWizard();
		expect(await screen.findByTestId("bootstrap-choose")).toBeInTheDocument();
		expect(screen.getByTestId("choose-fresh")).toBeInTheDocument();
		expect(screen.getByTestId("choose-restore")).toBeInTheDocument();
		// The import wizard's content must not be on screen yet.
		expect(screen.queryByText(/Importable skills/i)).not.toBeInTheDocument();
	});

	it("reaches the import wizard only after choosing 'Set up fresh'", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-fresh"));
		expect(await screen.findByText(/Importable skills/i)).toBeInTheDocument();
	});
});

describe("BootstrapWizard — restore branch", () => {
	/** Shared body for the two `restore_preview` failure shapes below: a
	 *  rejected promise (a thrown network/transport error) and a resolved
	 *  `{ ok: false }` payload (the CLI's own refusal). Both must retry clean,
	 *  with no false trust preview in between. */
	async function retriesFailedConnection(failureKind: "payload" | "rejection") {
		const user = userEvent.setup();
		let attempts = 0;
		mockBootstrap({ restore_preview: () => {
			if (++attempts > 1) return plan;
			const error = "could not clone the snapshot: Host key verification failed. ghp_testToken";
			if (failureKind === "rejection") throw new Error(error);
			return { ok: false, error };
		} });
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		const field = screen.getByLabelText(/Snapshot repo URL or local directory/i);
		await user.type(field, "git@github.com:Ramtoi/skill-tree-backup.git");
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("bootstrap-restore-error");
		await user.click(screen.getByText("Technical details"));
		expect(screen.queryByText(/ghp_testToken/)).not.toBeInTheDocument();
		const operations = Processes.list().filter((p) => p.target === "backup:restore");
		const operation = operations[operations.length - 1];
		expect(operation?.status).toBe("error");
		expect(operation?.body).not.toContain("ghp_testToken");
		expect(screen.queryByTestId("restore-consequences")).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/Trust and pin/)).not.toBeInTheDocument();
		expect(screen.getByTestId("bootstrap-restore-apply")).toHaveAttribute("aria-disabled", "true");
		expect(field).toHaveValue("git@github.com:Ramtoi/skill-tree-backup.git");
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");
		expect(calls).not.toContain("restore_apply");
	}

	it("retries a failed connection (payload) without a false trust preview", async () => {
		await retriesFailedConnection("payload");
	});

	it("retries a failed connection (rejection) without a false trust preview", async () => {
		await retriesFailedConnection("rejection");
	});

	it("skips the import wizard entirely", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));

		expect(await screen.findByTestId("bootstrap-restore-step")).toBeInTheDocument();
		expect(screen.queryByText(/Importable skills/i)).not.toBeInTheDocument();
	});

	it("never calls the import commands, through preview and apply", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));

		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");

		// Executable state present ⇒ consent gate must be satisfied first, and
		// this plan lists a loss ⇒ so must the typed gate.
		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		await user.click(screen.getByTestId("bootstrap-restore-apply"));

		await waitFor(() => expect(calls).toContain("restore_apply"));
		for (const cmd of IMPORT_COMMANDS) {
			expect(calls).not.toContain(cmd);
		}
	});

	/**
	 * The two screens described `merge` with OPPOSITE conflict rules: this one
	 * said "keep what's here", the Backup screen's danger zone said "the backup
	 * wins conflicts". A user reading both, four clicks before an irreversible
	 * write, got contradictory promises about which side survives.
	 *
	 * `restore.py::merge_registry` is `merged.update(value)` with `value` = the
	 * snapshot, so the backup overwrites and "keep what's here" was false. Both
	 * pickers now render from RESTORE_MODE_LABELS; this asserts the rendered
	 * option, not the constant, so a screen that hard-codes its own string again
	 * fails here rather than shipping.
	 */
	it("describes merge exactly as the Backup screen does", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));

		// Both consequences are on screen at once now (radio cards, not a
		// <select> that hid `replace` behind a click). The rendered card is what
		// is asserted, not the constant, so a screen that hard-codes its own
		// wording again fails here rather than shipping.
		const mergeCard = screen.getByTestId("bootstrap-restore-mode-merge");
		const mergeConsequence = RESTORE_MODE_LABELS.merge.split(" \u2014 ")[1];
		expect(mergeCard).toHaveTextContent("merge");
		expect(mergeCard).toHaveTextContent(mergeConsequence);
		expect(mergeCard).toHaveTextContent("the backup wins conflicts");
		expect(mergeCard.textContent).not.toMatch(/keep what'?s here/i);

		const replaceCard = screen.getByTestId("bootstrap-restore-mode-replace");
		expect(replaceCard).toHaveTextContent(
			RESTORE_MODE_LABELS.replace.split(" \u2014 ")[1],
		);
		// The destructive half's cost is visible WITHOUT opening anything.
		expect(replaceCard).toBeVisible();
	});

	it("previews as a dry run — no apply happens until the user confirms", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));

		await waitFor(() => expect(calls).toContain("restore_preview"));
		expect(calls).not.toContain("restore_apply");
	});

	it("blocks apply until the executable state is explicitly accepted", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");

		const apply = screen.getByTestId("bootstrap-restore-apply");
		expect(apply).toHaveAttribute("aria-disabled", "true");
		await user.click(apply);
		expect(calls).not.toContain("restore_apply");

		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		await user.click(apply);
		await waitFor(() => expect(calls).toContain("restore_apply"));
	});

	/**
	 * A first-run wizard is not a licence to make a destructive restore one
	 * click cheaper. Whenever the plan lists losses (or this machine already
	 * holds hub content) the same typed word the Backup screen's danger zone
	 * demands is demanded here.
	 */
	it("demands the typed confirmation when the plan lists losses", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");

		expect(screen.getByTestId("bootstrap-restore-typed-gate")).toBeInTheDocument();

		const apply = screen.getByTestId("bootstrap-restore-apply");
		await user.click(screen.getByLabelText(/Accept executable state/i));
		// Every other gate satisfied — the typed word alone still holds it shut.
		expect(apply).toHaveAttribute("aria-disabled", "true");
		await user.click(apply);
		expect(calls).not.toContain("restore_apply");

		// A near-miss does not count.
		await user.type(screen.getByLabelText(/Type/i), "restor");
		expect(apply).toHaveAttribute("aria-disabled", "true");

		await user.type(screen.getByLabelText(/Type/i), "e");
		await user.click(apply);
		await waitFor(() => expect(calls).toContain("restore_apply"));
	});

	it("skips the typed gate for a genuinely empty first run", async () => {
		const user = userEvent.setup();
		mockBootstrap({
			restore_preview: {
				...plan,
				registry: {
					target_populated: false,
					mode_required: false,
					diff: { sections: {}, top_level_added: [], top_level_lost: [], totals: {} },
				},
			},
		});
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");

		expect(screen.queryByTestId("bootstrap-restore-typed-gate")).not.toBeInTheDocument();
		await user.click(screen.getByLabelText(/Accept executable state/i));
		expect(screen.getByTestId("bootstrap-restore-apply")).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
	});

	/**
	 * `replace` is the right answer for a genuinely new machine and a data-loss
	 * event for anyone else. The default must be the safe half of that pair.
	 */
	it("defaults to merge, not replace", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		expect(screen.getByLabelText(RESTORE_MODE_LABELS.merge)).toBeChecked();
		expect(screen.getByLabelText(RESTORE_MODE_LABELS.replace)).not.toBeChecked();
	});

	/** Same stale-plan hole the Backup screen's danger zone had: consent given
	 *  for one previewed request must not authorize a different one. */
	it("discards the previewed plan and its consents when the source or mode changes", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));

		const field = screen.getByLabelText(/Snapshot repo URL or local directory/i);
		await user.type(field, "git@github.com:me/a.git");
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");
		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		expect(screen.getByTestId("bootstrap-restore-apply")).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);

		await user.click(screen.getByLabelText(RESTORE_MODE_LABELS.replace));

		// The plan is gone, so there is nothing left to apply…
		expect(screen.queryByTestId("restore-consequences")).not.toBeInTheDocument();
		expect(screen.getByTestId("bootstrap-restore-apply")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await user.click(screen.getByTestId("bootstrap-restore-apply"));
		expect(calls).not.toContain("restore_apply");

		// …and the consents come back UNTICKED after a fresh preview.
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");
		expect(screen.getByLabelText(/Accept executable state/i)).not.toBeChecked();
		expect(screen.getByLabelText(/Type/i)).toHaveValue("");
	});

	/** The apply must carry the request the plan was built from. */
	it("applies the previewed source and mode, not a later edit", async () => {
		const user = userEvent.setup();
		let applyArgs: Record<string, unknown> | null = null;
		mockBootstrap({
			restore_apply: (a?: unknown) => {
				applyArgs = (a ?? {}) as Record<string, unknown>;
				return { ...plan, ok: true, apply: true, errors: [] };
			},
		});
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByLabelText(RESTORE_MODE_LABELS.replace));
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");
		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		await user.click(screen.getByTestId("bootstrap-restore-apply"));

		await waitFor(() => expect(applyArgs).not.toBeNull());
		expect(applyArgs).toMatchObject({ source: "git@github.com:me/b.git", mode: "replace" });
	});

	it("enumerates the consequences before the destructive click", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));

		await screen.findByTestId("restore-consequences");
		// What the machine loses…
		expect(screen.getByTestId("restore-lost")).toHaveTextContent("scratch");
		// …the hook command VERBATIM…
		expect(screen.getByTestId("restore-executable")).toHaveTextContent("/bin/fmt.sh --all");
		// …and the writes that land outside the data home.
		expect(screen.getByTestId("restore-out-of-home")).toHaveTextContent(
			"~/.claude/agents/reviewer.md",
		);
	});

	/**
	 * B2 — both actions open dead, and a `disabledReason` title only pays out on
	 * hover. The first-run user who cannot tell why nothing is clickable is
	 * exactly the one who will not think to hover a disabled control, so the
	 * blocker is named in the open and tracks the gate that is actually shut.
	 */
	it("names the blocker while Preview and Restore are disabled", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));

		// Empty source: the blocker is the field, and it says so.
		const hint = await screen.findByTestId("bootstrap-restore-blocker");
		expect(hint).toHaveTextContent(/snapshot repo URL or a local directory/i);
		expect(screen.getByTestId("bootstrap-restore-preview")).toHaveAttribute(
			"aria-disabled",
			"true",
		);

		// With a source, the blocker moves on to the missing preview.
		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		expect(screen.getByTestId("bootstrap-restore-blocker")).toHaveTextContent(
			/preview/i,
		);
		expect(
			screen.getByTestId("bootstrap-restore-preview"),
		).not.toHaveAttribute("aria-disabled", "true");
	});

	/** B2 — mode is a choice between a non-destructive and a destructive write;
	 *  it is not a dropdown. */
	it("offers the two modes as radios, and switching one discards the plan", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));

		const radios = screen.getAllByRole("radio");
		expect(radios).toHaveLength(2);
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

		await user.type(
			screen.getByLabelText(/Snapshot repo URL or local directory/i),
			"git@github.com:me/b.git",
		);
		await user.click(screen.getByTestId("bootstrap-restore-preview"));
		await screen.findByTestId("restore-consequences");

		await user.click(screen.getByLabelText(RESTORE_MODE_LABELS.replace));
		expect(screen.getByLabelText(RESTORE_MODE_LABELS.replace)).toBeChecked();
		expect(screen.queryByTestId("restore-consequences")).not.toBeInTheDocument();
	});

	it("can back out of the restore branch to the choice screen", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		await user.click(await screen.findByRole("button", { name: /^Back$/ }));
		expect(await screen.findByTestId("bootstrap-choose")).toBeInTheDocument();
	});
});

describe("BootstrapWizard — optional backup step", () => {
	it("offers backup AFTER the import applies, and is skippable", async () => {
		const user = userEvent.setup();
		mockBootstrap({ bootstrap_run: undefined });
		renderWizard();

		await user.click(await screen.findByTestId("choose-fresh"));
		await user.click(await screen.findByRole("button", { name: /Initialize Skill Tree/i }));

		// The wizard must NOT vanish the moment import finishes — the optional
		// backup step renders next.
		expect(await screen.findByTestId("bootstrap-backup-step")).toBeInTheDocument();
		expect(screen.getByTestId("bootstrap-backup-skip")).toBeInTheDocument();
		expect(screen.getByText(/Optional/i)).toBeInTheDocument();
	});

	it("does not appear on the restore branch (a restored hub already has one)", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.click(await screen.findByTestId("choose-restore"));
		expect(screen.queryByTestId("bootstrap-backup-step")).not.toBeInTheDocument();
	});
});
