import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { RestoreDangerZone } from "@/components/backup/RestoreDangerZone";
import { ToastContainer } from "@/components/Toast";
import { renderWithProviders } from "@/test/helpers";

/**
 * The restore consent gates, against the REAL `hub restore --json` shape.
 *
 * `restore.py::classify_trust` splits into three outcomes the UI must treat
 * differently, and getting them wrong is either a security hole or a dead end:
 *
 * - `verified` — proceed, no extra consent;
 * - `unverified-new-key` (and the unsigned pair) — TOFU, cleared by
 *   `--trust-new-key`, which the app MUST send because the CLI's interactive
 *   prompt is unreachable behind `--json`;
 * - `key-mismatch` / `invalid-signature` — `hard: true`, `fatal: true`. No flag
 *   overrides these, so the UI must refuse rather than offer a checkbox that
 *   cannot work.
 */

const trust = {
	verified: {
		state: "verified",
		ok: true,
		hard: false,
		detail: "signed by the key pinned for this source",
		key_id: "SHA256:aaaa1111",
		pinned_key_id: "SHA256:aaaa1111",
	},
	newKey: {
		state: "unverified-new-key",
		ok: false,
		hard: false,
		detail:
			"UNVERIFIED SNAPSHOT (new signing key SHA256:aaaa1111) — this machine has never seen " +
			"a snapshot from this source. Re-run with --trust-new-key to accept and pin it.",
		key_id: "SHA256:aaaa1111",
		pinned_key_id: null,
	},
	mismatch: {
		state: "key-mismatch",
		ok: false,
		hard: true,
		detail:
			"this source is pinned to signing key SHA256:bbbb2222 but the snapshot is signed by " +
			"SHA256:aaaa1111 — refusing.",
		key_id: "SHA256:aaaa1111",
		pinned_key_id: "SHA256:bbbb2222",
	},
};

function plan(
	over: Record<string, unknown> = {},
	trustBlock: Record<string, unknown> = trust.verified,
) {
	return {
		ok: false,
		fatal: false,
		apply: false,
		source: "git@github.com:me/b.git",
		mode: "merge",
		integrity: {
			tree_digest: { ok: true, detail: "tree digest matches" },
			trust: trustBlock,
			ok: trustBlock.ok === true,
		},
		registry: {
			target_populated: false,
			mode_required: false,
			diff: {
				sections: { skills: { added: [], lost: ["local-only"], conflicts: [] } },
				top_level_added: [],
				top_level_lost: [],
				totals: { added: 0, lost: 1, conflicts: 0 },
			},
		},
		projects: [],
		subagents: [],
		global_docs: [],
		executable_state: {
			hooks: [{ name: "fmt", event: "PostToolUse", command: "/bin/fmt.sh", broken: false }],
			permission_rules: [],
			codex_trust: [],
			any: true,
			broken_hooks: [],
			accepted: false,
			requires_consent: true,
		},
		warnings: [],
		errors: [],
		next_steps: [],
		...over,
	};
}

/** The truncated payload `build_plan` returns on a hard integrity failure. */
const fatalPlan = {
	ok: false,
	fatal: true,
	apply: false,
	source: "git@github.com:me/b.git",
	mode: "merge",
	integrity: {
		tree_digest: { ok: false, detail: "tree digest mismatch — snapshot is incomplete" },
		trust: trust.newKey,
		ok: false,
	},
	warnings: [],
	errors: ["integrity: tree digest mismatch — snapshot is incomplete"],
};

let lastApplyArgs: Record<string, unknown> | null = null;

function mockRestore(preview: unknown) {
	lastApplyArgs = null;
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "restore_preview") return preview;
		if (cmd === "restore_apply") {
			lastApplyArgs = (args ?? {}) as Record<string, unknown>;
			return { ...(preview as object), ok: true, apply: true, errors: [] };
		}
		return prev ? prev(cmd as never, args as never) : undefined;
	}) as never);
}

function render() {
	return renderWithProviders(
		<>
			<RestoreDangerZone />
			<ToastContainer />
		</>,
	);
}

async function previewFor(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText(/Snapshot repo URL or local directory/i), "/snap");
	await user.click(screen.getByTestId("restore-preview-btn"));
	await screen.findByTestId("restore-consequences");
}

beforeEach(() => mockRestore(plan()));

describe("RestoreDangerZone — trust gates", () => {
	it("a verified snapshot needs only the executable consent and the typed word", async () => {
		const user = userEvent.setup();
		render();
		await previewFor(user);

		expect(screen.queryByTestId("restore-unverified")).not.toBeInTheDocument();

		await user.click(screen.getByTestId("restore-apply-btn"));
		expect(screen.queryByLabelText(/Trust and pin this signing key/i)).not.toBeInTheDocument();

		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		await user.click(screen.getByRole("button", { name: /^Restore$/ }));

		await waitFor(() => expect(lastApplyArgs).not.toBeNull());
		expect(lastApplyArgs).toMatchObject({ trustNewKey: false, acceptExecutableState: true });
	});

	it("an unverified new key blocks the apply until it is explicitly trusted", async () => {
		mockRestore(plan({}, trust.newKey));
		const user = userEvent.setup();
		render();
		await previewFor(user);

		// The banner shows the CLI's own sentence, not a re-worded summary.
		const banner = screen.getByTestId("restore-unverified");
		expect(banner).toHaveTextContent(/new signing key SHA256:aaaa1111/);
		expect(banner).toHaveAttribute("data-trust-state", "unverified-new-key");

		await user.click(screen.getByTestId("restore-apply-btn"));
		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");

		// Both other gates satisfied — the key consent alone still holds it shut.
		const confirm = screen.getByRole("button", { name: /^Restore$/ });
		expect(confirm).toBeDisabled();
		expect(screen.getByTestId("restore-block-reason")).toHaveTextContent(
			/unverified signing key/i,
		);

		await user.click(screen.getByLabelText(/Trust and pin this signing key/i));
		await user.click(confirm);

		await waitFor(() => expect(lastApplyArgs).not.toBeNull());
		// Without this flag the CLI refuses — its interactive TOFU prompt is
		// unreachable behind --json.
		expect(lastApplyArgs).toMatchObject({ trustNewKey: true });
	});

	it("refuses a hard key mismatch outright — no consent path is offered", async () => {
		mockRestore(plan({ fatal: true, errors: [`trust: ${trust.mismatch.detail}`] }, trust.mismatch));
		const user = userEvent.setup();
		render();
		await previewFor(user);

		expect(screen.getByTestId("restore-unverified")).toHaveTextContent(/refusing/i);
		// The dialog cannot even be opened, so there is nothing to consent to.
		expect(screen.getByTestId("restore-apply-btn")).toHaveAttribute("aria-disabled", "true");
		await user.click(screen.getByTestId("restore-apply-btn"));
		expect(screen.queryByLabelText(/Trust and pin this signing key/i)).not.toBeInTheDocument();
	});

	it("refuses a snapshot whose tree digest does not match, and says why", async () => {
		mockRestore(fatalPlan);
		const user = userEvent.setup();
		render();
		await previewFor(user);

		expect(screen.getByTestId("restore-integrity-failed")).toHaveTextContent(
			/integrity check failed/i,
		);
		expect(screen.getByTestId("restore-apply-btn")).toHaveAttribute("aria-disabled", "true");
	});
});

describe("RestoreDangerZone — the plan is bound to the inputs it was previewed with", () => {
	/** Echoes the request back the way `restore.py` does, so the rendered plan
	 *  and the applied request can be told apart by source AND by mode. */
	function mockEchoingRestore() {
		lastApplyArgs = null;
		const previewCalls: Record<string, unknown>[] = [];
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			const a = (args ?? {}) as { source?: string; mode?: string };
			if (cmd === "restore_preview") {
				previewCalls.push(a as Record<string, unknown>);
				return plan({ source: a.source, mode: a.mode });
			}
			if (cmd === "restore_apply") {
				lastApplyArgs = a as Record<string, unknown>;
				return { ...plan({ source: a.source, mode: a.mode }), ok: true, apply: true, errors: [] };
			}
			return prev ? prev(cmd as never, args as never) : undefined;
		}) as never);
		return previewCalls;
	}

	async function fillAndPreview(
		user: ReturnType<typeof userEvent.setup>,
		source: string,
		mode?: "merge" | "replace",
	) {
		const field = screen.getByLabelText(/Snapshot repo URL or local directory/i);
		await user.clear(field);
		await user.type(field, source);
		if (mode) await user.selectOptions(screen.getByLabelText(/^Mode$/i), mode);
		await user.click(screen.getByTestId("restore-preview-btn"));
		await screen.findByTestId("restore-consequences");
	}

	/**
	 * The exact reported hole: preview A/merge, edit the form to B/replace, and
	 * the confirm dialog still shows A's consequences while the apply would send
	 * B/replace. Consent for one snapshot must never authorize another.
	 */
	it("discards a stale plan when the source or the mode changes, and applies the RE-previewed one", async () => {
		mockEchoingRestore();
		const user = userEvent.setup();
		render();

		// ── A, in merge mode ──
		await fillAndPreview(user, "/snap-a", "merge");
		expect(screen.getByTestId("restore-consequences")).toHaveTextContent("/snap-a");
		expect(screen.getByTestId("restore-consequences")).toHaveTextContent("merge");

		// ── Edit the source: the previewed plan no longer describes what would
		//    happen, so there is nothing left to apply. ──
		const field = screen.getByLabelText(/Snapshot repo URL or local directory/i);
		await user.clear(field);
		await user.type(field, "/snap-b");
		expect(screen.queryByTestId("restore-consequences")).not.toBeInTheDocument();
		expect(screen.queryByTestId("restore-apply-btn")).not.toBeInTheDocument();

		// ── Same for the mode, after a fresh preview ──
		await user.click(screen.getByTestId("restore-preview-btn"));
		await screen.findByTestId("restore-consequences");
		await user.selectOptions(screen.getByLabelText(/^Mode$/i), "replace");
		expect(screen.queryByTestId("restore-apply-btn")).not.toBeInTheDocument();

		// ── Re-preview: NOW the dialog describes B/replace, and that is what the
		//    apply sends. ──
		await user.click(screen.getByTestId("restore-preview-btn"));
		await screen.findByTestId("restore-consequences");
		await user.click(screen.getByTestId("restore-apply-btn"));

		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("/snap-b");
		expect(dialog).toHaveTextContent("replace");

		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		await user.click(screen.getByRole("button", { name: /^Restore$/ }));

		await waitFor(() => expect(lastApplyArgs).not.toBeNull());
		expect(lastApplyArgs).toMatchObject({ source: "/snap-b", mode: "replace" });
	});

	it("re-arms the consent gates after a re-preview — a tick does not carry over", async () => {
		mockEchoingRestore();
		const user = userEvent.setup();
		render();

		await fillAndPreview(user, "/snap-a", "merge");
		await user.click(screen.getByTestId("restore-apply-btn"));
		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		expect(screen.getByRole("button", { name: /^Restore$/ })).toBeEnabled();

		// Change the mode from inside the (now stale) flow.
		await user.selectOptions(screen.getByLabelText(/^Mode$/i), "replace");
		await fillAndPreview(user, "/snap-a", "replace");
		await user.click(screen.getByTestId("restore-apply-btn"));

		expect(screen.getByLabelText(/Accept executable state/i)).not.toBeChecked();
		expect(screen.getByLabelText(/Type/i)).toHaveValue("");
		expect(screen.getByRole("button", { name: /^Restore$/ })).toBeDisabled();
	});

	/**
	 * The apply is built from what was REQUESTED, not from what the CLI echoed
	 * back. A payload whose `source`/`mode` drifted (an alias resolved to a cache
	 * path, an omitted echo) must not redirect a destructive apply somewhere the
	 * user never asked for.
	 */
	it("applies the requested source/mode even when the payload echoes something else", async () => {
		lastApplyArgs = null;
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			// Deliberately does NOT echo the request back.
			if (cmd === "restore_preview")
				return plan({ source: "~/.skill-hub/state/restore-cache/deadbeef", mode: "replace" });
			if (cmd === "restore_apply") {
				lastApplyArgs = (args ?? {}) as Record<string, unknown>;
				return { ...plan(), ok: true, apply: true, errors: [] };
			}
			return prev ? prev(cmd as never, args as never) : undefined;
		}) as never);

		const user = userEvent.setup();
		render();

		await fillAndPreview(user, "/snap-a", "merge");
		await user.click(screen.getByTestId("restore-apply-btn"));
		await user.click(screen.getByLabelText(/Accept executable state/i));
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		await user.click(screen.getByRole("button", { name: /^Restore$/ }));

		await waitFor(() => expect(lastApplyArgs).not.toBeNull());
		expect(lastApplyArgs).toMatchObject({ source: "/snap-a", mode: "merge" });
	});
});

describe("RestoreDangerZone — restored code the app itself will load", () => {
	/** Executable state consisting ONLY of restored connector / MCP-server code
	 *  — no hooks, no permission rules, no trust grants. */
	const codeOnlyPlan = plan({
		executable_state: {
			hooks: [],
			permission_rules: [],
			codex_trust: [],
			code_dirs: [
				{
					kind: "connector",
					section: "connectors",
					name: "hermes",
					files: ["__init__.py", "hermes.py"],
					action: "new",
				},
				{
					kind: "connector",
					section: "connectors",
					name: "unchanged",
					files: ["a.py"],
					action: "identical",
				},
			],
			any: true,
			broken_hooks: [],
			accepted: false,
			requires_consent: true,
		},
	});

	/**
	 * The reported adapter gap, seen from the UI: `requires_consent` was true
	 * while the flattener knew about three named arrays only, so the dialog
	 * asked the user to accept "the 0 executable items above" and listed
	 * nothing. Consent to an empty list is not consent.
	 */
	it("names the connector in the consent dialog instead of listing nothing", async () => {
		mockRestore(codeOnlyPlan);
		const user = userEvent.setup();
		render();
		await previewFor(user);

		const group = screen.getByTestId("restore-code-dirs");
		expect(group).toHaveTextContent("hermes");
		expect(group).toHaveTextContent("connector");
		// Said plainly: this is code hub loads, not a command it hands over.
		expect(group).toHaveTextContent(/import and execute/i);
		// The files are named, so "what am I accepting" has an answer.
		expect(screen.getByTestId("code-dir-files")).toHaveTextContent("hermes.py");
		// A byte-identical dir installs nothing and must not pad the list.
		expect(group).not.toHaveTextContent("unchanged");

		await user.click(screen.getByTestId("restore-apply-btn"));
		const consent = screen.getByLabelText(/Accept executable state/i);
		expect(consent).toBeInTheDocument();
		// The count the checkbox quotes matches what is actually shown (1, not 0).
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("I accept the 1 executable item above");
		expect(dialog).toHaveTextContent(/connector \/ MCP code will run on this machine/i);
		expect(dialog).toHaveTextContent("hermes");

		// And it really is the gate: ticking it is what unblocks the apply.
		await user.type(screen.getByLabelText(/Type/i), "RESTORE");
		expect(screen.getByRole("button", { name: /^Restore$/ })).toBeDisabled();
		await user.click(consent);
		expect(screen.getByRole("button", { name: /^Restore$/ })).toBeEnabled();
	});

	it("flags an overwrite of code already on this machine", async () => {
		mockRestore(
			plan({
				executable_state: {
					hooks: [],
					permission_rules: [],
					codex_trust: [],
					code_dirs: [
						{
							kind: "mcp-server",
							section: "mcp-servers",
							name: "search",
							files: ["server.py"],
							action: "overwrite",
						},
					],
					requires_consent: true,
				},
			}),
		);
		const user = userEvent.setup();
		render();
		await previewFor(user);

		expect(screen.getByTestId("restore-code-dirs")).toHaveTextContent(/overwrites local code/i);
	});

	it("keeps hooks in their own group when both kinds are present", async () => {
		mockRestore(
			plan({
				executable_state: {
					hooks: [{ name: "fmt", event: "PostToolUse", command: "/bin/fmt.sh", broken: false }],
					permission_rules: [],
					codex_trust: [],
					code_dirs: [
						{ kind: "connector", section: "connectors", name: "hermes", files: [], action: "new" },
					],
					requires_consent: true,
				},
			}),
		);
		const user = userEvent.setup();
		render();
		await previewFor(user);

		expect(screen.getByTestId("restore-executable")).toHaveTextContent("/bin/fmt.sh");
		expect(screen.getByTestId("restore-executable")).not.toHaveTextContent("hermes");
		expect(screen.getByTestId("restore-code-dirs")).toHaveTextContent("hermes");
	});

	it("surfaces retained files and the audit-ledger note when the payload has them", async () => {
		mockRestore(
			plan({
				data: { skills: { retained: ["skills/local-only/SKILL.md"] } },
				report: {
					retained_extra_files: ["state/x.json"],
					audit_ledgers_note: "2 append-only ledgers were merged, not replaced",
				},
			}),
		);
		const user = userEvent.setup();
		render();
		await previewFor(user);

		expect(screen.getByTestId("restore-retained")).toHaveTextContent("2");
		expect(screen.getByTestId("restore-audit-note")).toHaveTextContent(
			"2 append-only ledgers were merged, not replaced",
		);
	});
});

describe("RestoreDangerZone — consequence derivation from the real shape", () => {
	it("lists a sibling write at the path actually written, not the local file", async () => {
		mockRestore(
			plan({
				global_docs: [
					{
						harness: "claude-code",
						name: "CLAUDE.md",
						target: "/Users/alice/.claude/CLAUDE.md",
						action: "sibling",
						detail: "differs from the local file",
					},
				],
				subagents: [
					{
						harness: "claude-code",
						name: "same.md",
						target: "/Users/alice/.claude/agents/same.md",
						action: "skip",
						detail: "identical",
					},
				],
			}),
		);
		const user = userEvent.setup();
		render();
		await previewFor(user);

		const group = screen.getByTestId("restore-out-of-home");
		expect(group).toHaveTextContent("/Users/alice/.claude/CLAUDE.md.from-backup");
		// An identical file is not a write and must not be listed as one.
		expect(group).not.toHaveTextContent("same.md");
	});
});
