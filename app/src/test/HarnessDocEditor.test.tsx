import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { EditorView } from "@codemirror/view";
import { join } from "node:path";

import { QueryClient } from "@tanstack/react-query";

import { HarnessDocEditor } from "@/screens/HarnessDocEditor";
import { useAppStore, type HarnessStatus } from "@/store";
import { Processes } from "@/store/processes";
import { qk } from "@/lib/queryKeys";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import type { GlobalDocStatusRow } from "@/hooks/useGlobalDocStatus";
import { renderWithProviders } from "./helpers";
import { expectOnlySidePanelSections } from "./helpers/disclosureGuard";

const CLAUDE: HarnessStatus = {
	id: "claude-code",
	label: "Claude Code",
	installed: true,
	on_globally: true,
	used_by_projects: [],
	global_doc: "/home/test/.claude/CLAUDE.md",
	global_doc_exists: true,
};

const CODEX_MISSING: HarnessStatus = {
	id: "codex",
	label: "Codex",
	installed: true,
	on_globally: false,
	used_by_projects: [],
	global_doc: "/home/test/.codex/AGENTS.md",
	global_doc_exists: false,
};

/** `hub harness doc status --json` default fixture: claude-code is a plain
 *  standalone file, codex is missing — matches `CLAUDE`/`CODEX_MISSING`
 *  above so the SHARED WITH row it drives reads consistently. */
const DEFAULT_DOC_STATUS = [
	{
		harness: "claude-code",
		label: "Claude Code",
		path: "/home/test/.claude/CLAUDE.md",
		state: "standalone",
		follows: null,
		followers: [],
		bytes: 24,
	},
	{
		harness: "codex",
		label: "Codex",
		path: "/home/test/.codex/AGENTS.md",
		state: "missing",
		follows: null,
		followers: [],
		bytes: null,
	},
];

/** A `hub_cmd` handler covering `harness doc status --json` (every other
 *  hub_cmd verb falls back to an empty success — no test in this file needs
 *  more than that). */
function hubCmdDefault(args?: unknown, rows: unknown[] = DEFAULT_DOC_STATUS) {
	const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
	if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc" && cmdArgs[2] === "status") {
		return { success: true, output: JSON.stringify(rows) };
	}
	return { success: true, output: "" };
}

/** The shell carries the unsaved state as a dot ON the Save button (the
 *  standalone UNSAVED pill was removed), so "is dirty" reads off that. */
function expectDirty() {
	return waitFor(() =>
		expect(
			document.querySelector(".doc-editor-bar-right .btn-signal"),
		).toBeInTheDocument(),
	);
}

function renderEditor(route: string) {
	return renderWithProviders(
		<Routes>
			<Route path="/harness/:id/doc" element={<HarnessDocEditor />} />
		</Routes>,
		{ initialRoute: route },
	);
}

/** Reliably drive a CodeMirror text change (fires onChange → marks dirty).
 *  Waits until the seeded content has settled (so the dispatch isn't clobbered
 *  by the async load's seeding effect) before inserting.
 *
 *  The dispatch runs inside `act` so React flushes the passive effects of the
 *  resulting render before the caller continues. The shell re-registers its
 *  ⌘S listener in an effect keyed on `dirty`; without the flush, a keydown
 *  fired right after the dirty dot appears could still hit the stale
 *  `dirty=false` listener and save nothing (seen under parallel load). */
async function typeInto(
	container: HTMLElement,
	insert: string,
	settled = "",
) {
	await waitFor(() => {
		expect(container.querySelector(".cm-editor")).toBeInTheDocument();
		expect(container.querySelector(".cm-content")?.textContent ?? "").toContain(
			settled,
		);
	});
	const el = container.querySelector(".cm-editor") as HTMLElement;
	const view = EditorView.findFromDOM(el)!;
	await act(async () => {
		view.dispatch({ changes: { from: 0, insert } });
	});
}

function mockReadWrite(opts: {
	content?: string;
	exists?: boolean;
	sha256?: string | null;
	writeReject?: string;
	docStatus?: unknown[];
}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "global_doc_read") {
			return {
				path: "/home/test/.claude/CLAUDE.md",
				resolved_path: "/home/test/.claude/CLAUDE.md",
				is_link: false,
				exists: opts.exists ?? true,
				content: opts.content ?? "# Global\n\nBe concise.\n",
				sha256: opts.sha256 === undefined ? "sha-loaded" : opts.sha256,
			};
		}
		if (cmd === "global_doc_write") {
			if (opts.writeReject) throw new Error(opts.writeReject);
			return { sha256: "sha-written" };
		}
		if (cmd === "hub_cmd") return hubCmdDefault(args, opts.docStatus);
		return undefined;
	}) as never);
}

beforeEach(() => {
	useAppStore.setState({ harnesses: [CLAUDE, CODEX_MISSING], mutating: false });
});

describe("HarnessDocEditor", () => {
	it("loads the harness global doc into the editor shell", async () => {
		mockReadWrite({ content: "# Loaded body\n" });
		const { container } = renderEditor("/harness/claude-code/doc");
		await waitFor(() => {
			expect(document.querySelector(".doc-editor-shell")).toBeInTheDocument();
		});
		expect(invoke).toHaveBeenCalledWith("global_doc_read", {
			harnessId: "claude-code",
		});
		expect(screen.getByText("/home/test/.claude/CLAUDE.md")).toBeInTheDocument();
		// A present file has no plaque; the STATE row carries the fact instead.
		expect(screen.getByText("on disk")).toBeInTheDocument();

		// No section heads on this panel — it has no disclosure at all.
		const side = container.querySelector(".editor-side") as HTMLElement;
		expectOnlySidePanelSections(side, 0, [
			join(process.cwd(), "src", "screens", "HarnessDocEditor.tsx"),
		]);
	});

	it("edit → unsaved dot on Save → save calls write with the loaded sha", async () => {
		mockReadWrite({ content: "# Loaded body\n", sha256: "sha-loaded" });
		const { container } = renderEditor("/harness/claude-code/doc");
		await typeInto(container, "PREFIX ", "Loaded body");
		await expectDirty();

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"global_doc_write",
				expect.objectContaining({
					harnessId: "claude-code",
					expectedSha256: "sha-loaded",
				}),
			),
		);
	});

	it("a drift error surfaces the overwrite confirm; force-retry passes null sha", async () => {
		mockReadWrite({
			content: "# Loaded body\n",
			sha256: "sha-loaded",
			writeReject: "drift: CLAUDE.md changed on disk",
		});
		const { container } = renderEditor("/harness/claude-code/doc");
		await typeInto(container, "PREFIX ", "Loaded body");
		await expectDirty();

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		// Drift dialog appears with an Overwrite action.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /overwrite/i }),
			).toBeInTheDocument(),
		);

		// Now let the forced write succeed.
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "global_doc_write") return { sha256: "sha-written" };
			if (cmd === "harness_list") return [CLAUDE, CODEX_MISSING];
			if (cmd === "hub_cmd") return hubCmdDefault(args);
			return {
				path: "/home/test/.claude/CLAUDE.md",
				resolved_path: "/home/test/.claude/CLAUDE.md",
				is_link: false,
				exists: true,
				content: "# Loaded body\n",
				sha256: "sha-loaded",
			};
		}) as never);

		fireEvent.click(screen.getByRole("button", { name: /overwrite/i }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"global_doc_write",
				expect.objectContaining({
					harnessId: "claude-code",
					expectedSha256: null,
				}),
			),
		);
	});

	it("missing file → create-on-save note + first save (sha null)", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "global_doc_read") {
				return {
					path: "/home/test/.codex/AGENTS.md",
					resolved_path: "/home/test/.codex/AGENTS.md",
					is_link: false,
					exists: false,
					content: "",
					sha256: null,
				};
			}
			if (cmd === "global_doc_write") return { sha256: "sha-written" };
			if (cmd === "hub_cmd") return hubCmdDefault(args);
			return undefined;
		}) as never);

		const { container } = renderEditor("/harness/codex/doc");
		await waitFor(() =>
			expect(screen.getByText(/Not created yet/i)).toBeInTheDocument(),
		);
		expect(screen.getByText(/Saving creates it at this path/i)).toBeInTheDocument();
		// The plaque covers "missing" — no separate STATE row while it shows.
		expect(screen.queryByText("on disk")).toBeNull();

		await typeInto(container, "# new file\n");
		await expectDirty();
		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"global_doc_write",
				expect.objectContaining({
					harnessId: "codex",
					expectedSha256: null,
				}),
			),
		);
	});

	it("unknown harness id → EmptyState with a way back", async () => {
		mockReadWrite({});
		renderEditor("/harness/aider/doc");
		await waitFor(() =>
			expect(screen.getByText(/No such harness/i)).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: /Harnesses/i }),
		).toBeInTheDocument();
	});
});

describe("HarnessDocEditor — global-doc sharing (SHARED WITH)", () => {
	const STANDALONE_STATUS = [
		{
			harness: "claude-code",
			label: "Claude Code",
			path: "/home/test/.claude/CLAUDE.md",
			state: "standalone",
			follows: null,
			followers: [],
			bytes: 24,
		},
		{
			harness: "codex",
			label: "Codex",
			path: "/home/test/.codex/AGENTS.md",
			state: "standalone",
			follows: null,
			followers: [],
			bytes: 41,
		},
	];

	it("renders a row per other installed harness, from the status mock", async () => {
		mockReadWrite({ content: "# Loaded body\n", docStatus: STANDALONE_STATUS });
		renderEditor("/harness/claude-code/doc");
		await waitFor(() => expect(screen.getByText("Shared with")).toBeInTheDocument());
		expect(screen.getByText("own file · 41 chars")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "Share CLAUDE.md with Codex" }),
		).not.toBeChecked();
	});

	it("a follower doc renders the Follows plaque, not a SHARED WITH section", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "global_doc_read") {
				return {
					path: "/home/test/.codex/AGENTS.md",
					resolved_path: "/home/test/.claude/CLAUDE.md",
					is_link: true,
					exists: true,
					content: "# Loaded body\n",
					sha256: "sha-loaded",
				};
			}
			if (cmd === "hub_cmd") {
				return hubCmdDefault(args, [
					{
						harness: "claude-code",
						label: "Claude Code",
						path: "/home/test/.claude/CLAUDE.md",
						state: "source",
						follows: null,
						followers: ["codex"],
						bytes: 24,
					},
					{
						harness: "codex",
						label: "Codex",
						path: "/home/test/.codex/AGENTS.md",
						state: "follows",
						follows: "claude-code",
						followers: [],
						bytes: null,
					},
				]);
			}
			return undefined;
		}) as never);

		renderEditor("/harness/codex/doc");
		// Exact, case-sensitive: the plaque eyebrow reads "Follows Claude Code";
		// the (also-present) STATE kv row reads lowercase "follows Claude Code".
		await waitFor(() =>
			expect(screen.getByText("Follows Claude Code")).toBeInTheDocument(),
		);
		expect(screen.queryByText("Shared with")).toBeNull();
	});

	it("toggling a missing other doc ON calls `hub harness doc link`", async () => {
		mockReadWrite({ content: "# Loaded body\n" }); // DEFAULT_DOC_STATUS: codex missing
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		expect(toggle).not.toBeChecked();

		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "global_doc_read") {
				return {
					path: "/home/test/.claude/CLAUDE.md",
					resolved_path: "/home/test/.claude/CLAUDE.md",
					is_link: false,
					exists: true,
					content: "# Loaded body\n",
					sha256: "sha-loaded",
				};
			}
			if (cmd === "hub_cmd") {
				const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
				if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc" && cmdArgs[2] === "link") {
					return {
						success: true,
						output: JSON.stringify({
							follower: "codex",
							source: "claude-code",
							changed: true,
							backup: null,
						}),
					};
				}
				return hubCmdDefault(args);
			}
			return undefined;
		}) as never);

		fireEvent.click(toggle);

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("hub_cmd", {
				args: ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"],
			}),
		);
	});

	it("a conflict opens the confirm; Replace with link retries with --on-conflict replace", async () => {
		mockReadWrite({ content: "# Loaded body\n", docStatus: STANDALONE_STATUS });
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});

		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "global_doc_read") {
				return {
					path: "/home/test/.claude/CLAUDE.md",
					resolved_path: "/home/test/.claude/CLAUDE.md",
					is_link: false,
					exists: true,
					content: "# Loaded body\n",
					sha256: "sha-loaded",
				};
			}
			if (cmd === "hub_cmd") {
				const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
				if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc" && cmdArgs[2] === "link") {
					if (cmdArgs.includes("--on-conflict")) {
						return {
							success: true,
							output: JSON.stringify({
								follower: "codex",
								source: "claude-code",
								changed: true,
								backup: "mock-backup.md",
							}),
						};
					}
					return {
						success: false,
						output: JSON.stringify({
							error: "conflict",
							harness: "codex",
							existing_bytes: 41,
							preview: "# Codex own text\n",
						}),
					};
				}
				return hubCmdDefault(args, STANDALONE_STATUS);
			}
			return undefined;
		}) as never);

		fireEvent.click(toggle);

		await waitFor(() =>
			expect(screen.getByText("Codex has its own AGENTS.md")).toBeInTheDocument(),
		);

		fireEvent.click(screen.getByRole("button", { name: /replace with link/i }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("hub_cmd", {
				args: [
					"harness",
					"doc",
					"link",
					"codex",
					"--to",
					"claude-code",
					"--on-conflict",
					"replace",
					"--json",
				],
			}),
		);
	});

	it("SHARED WITH toggles disable while the editor has unsaved edits", async () => {
		mockReadWrite({ content: "# Loaded body\n", docStatus: STANDALONE_STATUS });
		const { container } = renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		expect(toggle).not.toBeDisabled();

		await typeInto(container, "PREFIX ", "Loaded body");
		await expectDirty();

		await waitFor(() => expect(toggle).toBeDisabled());
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Adversarial pass over global-doc sharing (B2 review). Every case here is a
 * state the backend can hand the editor: a third-harness follower, an external
 * link, a source with its own followers, a broken link, a failed status scan,
 * and the two writes that change bytes under an OPEN editor (merge) or under a
 * DIFFERENT harness's cached doc (link/unlink).
 * ──────────────────────────────────────────────────────────────────────────── */

const PI: HarnessStatus = {
	id: "pi",
	label: "Pi",
	installed: true,
	on_globally: false,
	used_by_projects: [],
	global_doc: "/home/test/.pi/agent/AGENTS.md",
	global_doc_exists: true,
};

interface DocEnv {
	/** Which harness's doc the editor is reading. */
	readFor?: string;
	path?: string;
	resolvedPath?: string;
	isLink?: boolean;
	content?: string;
	exists?: boolean;
	status: unknown[] | "fail";
	/** Extra `hub_cmd` answers, keyed by the verb (`link` / `unlink`). */
	onCmd?: (cmdArgs: string[]) => unknown | undefined;
}

const linkCalls: string[][] = [];

/** One mock for the whole sharing surface: a doc read, a status scan (or a
 *  failing one), and whatever the test wants `link`/`unlink` to answer. */
function mockDocEnv(env: DocEnv) {
	linkCalls.length = 0;
	const contentByPath = { current: env.content ?? "# Loaded body\n" };
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "global_doc_read") {
			return {
				path: env.path ?? "/home/test/.claude/CLAUDE.md",
				resolved_path:
					env.resolvedPath ?? env.path ?? "/home/test/.claude/CLAUDE.md",
				is_link: env.isLink ?? false,
				exists: env.exists ?? true,
				content: contentByPath.current,
				sha256: "sha-loaded",
			};
		}
		if (cmd === "global_doc_write") return { sha256: "sha-written" };
		if (cmd === "hub_cmd") {
			const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
			if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc") {
				if (cmdArgs[2] === "status") {
					if (env.status === "fail") {
						return { success: false, output: "python3: not found\n" };
					}
					return { success: true, output: JSON.stringify(env.status) };
				}
				linkCalls.push(cmdArgs);
				const custom = env.onCmd?.(cmdArgs);
				if (custom !== undefined) return custom;
				return {
					success: true,
					output: JSON.stringify({ changed: true, harness: cmdArgs[3] }),
				};
			}
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
	return contentByPath;
}

function row(over: Partial<GlobalDocStatusRow> & { harness: string }) {
	return {
		label: harnessLabel(over.harness),
		path: `/home/test/.${over.harness}/AGENTS.md`,
		state: "standalone",
		follows: null,
		followers: [],
		bytes: 41,
		...over,
	};
}

describe("HarnessDocEditor — sharing edge cases (adversarial)", () => {
	beforeEach(() => {
		for (const p of Processes.list()) Processes.dismiss(p.id);
	});

	it("the follower plaque names the SOURCE's file, not this harness's link", async () => {
		// The bug this pins: `basename(doc.path)` is codex's OWN AGENTS.md, but
		// the bytes live in Claude Code's CLAUDE.md. Naming the wrong file tells
		// the reader to look in a file that holds nothing.
		mockDocEnv({
			path: "/home/test/.codex/AGENTS.md",
			resolvedPath: "/home/test/.claude/CLAUDE.md",
			isLink: true,
			status: [
				row({
					harness: "claude-code",
					path: "/home/test/.claude/CLAUDE.md",
					state: "source",
					followers: ["codex"],
				}),
				row({ harness: "codex", state: "follows", follows: "claude-code", bytes: null }),
			],
		});
		renderEditor("/harness/codex/doc");

		const plaque = await waitFor(() => {
			const el = document.querySelector(".source-banner") as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		});
		expect(plaque.textContent).toContain("Claude Code's CLAUDE.md");
		expect(plaque.textContent).not.toContain("AGENTS.md");
	});

	it("a broken link shows the Broken link plaque and 'Start a fresh file' unlinks THIS harness", async () => {
		mockDocEnv({
			path: "/home/test/.codex/AGENTS.md",
			exists: false,
			content: "",
			isLink: true,
			status: [
				row({ harness: "codex", state: "broken", follows: "claude-code", bytes: null }),
			],
		});
		renderEditor("/harness/codex/doc");

		await waitFor(() =>
			expect(screen.getByText("Broken link")).toBeInTheDocument(),
		);
		expect(
			screen.getByText(/pointed at Claude Code's instructions/i),
		).toBeInTheDocument();
		// No SHARED WITH while the doc is a dangling link.
		expect(screen.queryByText("Shared with")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /start a fresh file/i }));
		await waitFor(() =>
			expect(linkCalls).toContainEqual([
				"harness",
				"doc",
				"unlink",
				"codex",
				"--json",
			]),
		);
	});

	it("an external link is left alone: no SHARED WITH, state says so", async () => {
		mockDocEnv({
			path: "/home/test/.codex/AGENTS.md",
			status: [row({ harness: "codex", state: "external", bytes: null })],
		});
		renderEditor("/harness/codex/doc");
		await waitFor(() =>
			expect(screen.getByText("linked elsewhere")).toBeInTheDocument(),
		);
		expect(screen.queryByText("Shared with")).toBeNull();
	});

	it("a row that follows a THIRD harness is disabled and says where to detach it", async () => {
		useAppStore.setState({ harnesses: [CLAUDE, CODEX_MISSING, PI] });
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "follows", follows: "pi", bytes: null }),
				row({ harness: "pi", state: "source", followers: ["codex"] }),
			],
		});
		renderEditor("/harness/claude-code/doc");

		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		expect(toggle).toBeDisabled();
		expect(screen.getByText("follows Pi · detach it there first")).toBeInTheDocument();
		expect(
			toggle.closest("span")?.parentElement?.getAttribute("title") ??
				toggle.closest("[title]")?.getAttribute("title"),
		).toMatch(/Detach it from Pi first/);

		// `userEvent`, not `fireEvent`: a disabled control receives no click in a
		// browser at all, and only userEvent models that.
		await userEvent.click(toggle).catch(() => {});
		expect(linkCalls).toEqual([]);
	});

	it("a row that is itself a SOURCE is disabled — `has_followers` would refuse it", async () => {
		useAppStore.setState({ harnesses: [CLAUDE, CODEX_MISSING, PI] });
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "source", followers: ["pi"] }),
				row({ harness: "pi", state: "follows", follows: "codex", bytes: null }),
			],
		});
		renderEditor("/harness/claude-code/doc");

		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		expect(toggle).toBeDisabled();
		expect(screen.getByText("shared with Pi · detach it first")).toBeInTheDocument();
		await userEvent.click(toggle).catch(() => {});
		expect(linkCalls).toEqual([]);
	});

	it("an external OTHER row is disabled and never links", async () => {
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "external", bytes: null }),
			],
		});
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		expect(toggle).toBeDisabled();
		expect(screen.getByText("linked elsewhere")).toBeInTheDocument();
		await userEvent.click(toggle).catch(() => {});
		expect(linkCalls).toEqual([]);
	});

	it("toggling OFF unlinks the OTHER harness, never this one", async () => {
		mockDocEnv({
			status: [
				row({
					harness: "claude-code",
					path: "/home/test/.claude/CLAUDE.md",
					state: "source",
					followers: ["codex"],
				}),
				row({ harness: "codex", state: "follows", follows: "claude-code", bytes: null }),
			],
		});
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		await waitFor(() => expect(toggle).toBeChecked());

		fireEvent.click(toggle);
		await waitFor(() =>
			expect(linkCalls).toEqual([
				["harness", "doc", "unlink", "codex", "--json"],
			]),
		);
	});

	it("a missing doc disables every toggle — a link needs a real target", async () => {
		mockDocEnv({
			exists: false,
			content: "",
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md", state: "missing", bytes: null }),
				row({ harness: "codex", state: "missing", bytes: null }),
			],
		});
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		expect(toggle).toBeDisabled();
		expect(
			toggle.closest("[title]")?.getAttribute("title") ??
				toggle.closest("span")?.parentElement?.getAttribute("title"),
		).toMatch(/Save this file first/);
	});

	it("two fast clicks on one toggle fire exactly one link", async () => {
		const gate: { release: (() => void) | null } = { release: null };
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "missing", bytes: null }),
			],
			onCmd: (cmdArgs) =>
				cmdArgs[2] === "link"
					? new Promise((res) => {
							gate.release = () =>
								res({ success: true, output: JSON.stringify({ changed: true }) });
						})
					: undefined,
		});
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});

		// Three impatient clicks in a row. The first one flips the row into its
		// in-flight state; a browser then delivers nothing to the disabled
		// control, so only one link is ever spawned.
		await userEvent.click(toggle).catch(() => {});
		await userEvent.click(toggle).catch(() => {});
		await userEvent.click(toggle).catch(() => {});
		await waitFor(() => expect(toggle).toBeDisabled());
		expect(linkCalls.filter((c) => c[2] === "link")).toHaveLength(1);
		gate.release?.();
	});

	it("a `has_followers` refusal reads as a sentence and opens no confirm", async () => {
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "standalone" }),
			],
			onCmd: (cmdArgs) =>
				cmdArgs[2] === "link"
					? {
							success: false,
							output: JSON.stringify({
								error: "has_followers",
								harness: "codex",
								followers: ["pi"],
							}),
						}
					: undefined,
		});
		renderEditor("/harness/claude-code/doc");
		const toggle = await screen.findByRole("checkbox", {
			name: "Share CLAUDE.md with Codex",
		});
		fireEvent.click(toggle);

		await waitFor(() => {
			const failed = Processes.list().find((p) => p.status === "error");
			expect(failed?.body).toBe(
				"Codex shares its own file with Pi — detach it there first.",
			);
		});
		// Not a conflict → no decision dialog.
		expect(screen.queryByText(/has its own/i)).toBeNull();
	});

	it("an UNKNOWN error code still reads as a sentence, never a raw code", async () => {
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "standalone" }),
			],
			onCmd: (cmdArgs) =>
				cmdArgs[2] === "link"
					? {
							success: false,
							output: JSON.stringify({ error: "source_not_a_file", harness: "claude-code" }),
						}
					: undefined,
		});
		renderEditor("/harness/claude-code/doc");
		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Share CLAUDE.md with Codex" }),
		);
		await waitFor(() => {
			const failed = Processes.list().find((p) => p.status === "error");
			expect(failed?.body).toMatch(/not a plain file/);
		});
	});

	it("merge re-seeds the open editor from the rewritten file", async () => {
		// The merge appends the OTHER harness's text to THIS file on disk. If
		// the buffers keep the pre-merge bytes, the next ⌘S silently deletes
		// what the merge just folded in.
		const state = mockDocEnv({
			content: "# Mine\n",
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "standalone" }),
			],
			onCmd: (cmdArgs) => {
				if (cmdArgs[2] !== "link") return undefined;
				if (cmdArgs.includes("--on-conflict")) {
					state.current = "# Mine\n\n# Theirs\n";
					return { success: true, output: JSON.stringify({ changed: true }) };
				}
				return {
					success: false,
					output: JSON.stringify({
						error: "conflict",
						harness: "codex",
						existing_bytes: 9,
						preview: "# Theirs\n",
					}),
				};
			},
		});
		const { container } = renderEditor("/harness/claude-code/doc");
		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Share CLAUDE.md with Codex" }),
		);

		const merge = await screen.findByRole("button", {
			name: /append its text here, then link/i,
		});
		fireEvent.click(merge);

		await waitFor(() =>
			expect(linkCalls).toContainEqual([
				"harness",
				"doc",
				"link",
				"codex",
				"--to",
				"claude-code",
				"--on-conflict",
				"merge",
				"--json",
			]),
		);
		await waitFor(() =>
			expect(container.querySelector(".cm-content")?.textContent ?? "").toContain(
				"# Theirs",
			),
		);
		// Re-seeded, not dirtied: the merged bytes ARE the saved state.
		expect(
			document.querySelector(".doc-editor-bar-right .btn-signal"),
		).toBeNull();
	});

	it("linking stales the OTHER harness's cached doc", async () => {
		// codex's `global_doc_read` cache is now a lie — its file became a link
		// to this one. Left fresh (30s `staleTime` in the real client), opening
		// codex's editor would seed pre-link bytes and trip the drift confirm.
		mockDocEnv({
			status: [
				row({ harness: "claude-code", path: "/home/test/.claude/CLAUDE.md" }),
				row({ harness: "codex", state: "missing", bytes: null }),
			],
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 60_000 } },
		});
		client.setQueryData(qk.globalDoc("codex"), {
			path: "/home/test/.codex/AGENTS.md",
			resolved_path: "/home/test/.codex/AGENTS.md",
			is_link: false,
			exists: true,
			content: "# stale codex bytes\n",
			sha256: "sha-old",
		});
		renderWithProviders(
			<Routes>
				<Route path="/harness/:id/doc" element={<HarnessDocEditor />} />
			</Routes>,
			{ initialRoute: "/harness/claude-code/doc", client },
		);

		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Share CLAUDE.md with Codex" }),
		);
		await waitFor(() =>
			expect(
				client.getQueryState(qk.globalDoc("codex"))?.isInvalidated,
			).toBe(true),
		);
	});

	it("a failed status scan says so instead of calling every harness 'not created'", async () => {
		mockDocEnv({ status: "fail" });
		renderEditor("/harness/claude-code/doc");
		await waitFor(() =>
			expect(screen.getByText(/Couldn't read who shares this file/i)).toBeInTheDocument(),
		);
		// No lying rows, and no error card over the editor itself.
		expect(screen.queryByRole("checkbox", { name: /^Share / })).toBeNull();
		expect(screen.queryByText("Couldn't load the instruction file")).toBeNull();
		expect(document.querySelector(".doc-editor-shell")).toBeInTheDocument();
	});
});
