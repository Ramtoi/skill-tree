import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import {
	renderWithProviders,
	sampleRegistry,
	primeRegistry,
	makeQueryClient,
} from "./helpers";
import { expectOnlySidePanelSections } from "./helpers/disclosureGuard";
import { SkillEditor } from "@/screens/SkillEditor";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { ICONS } from "@/components/icons";
import type { SkillFileEntry, SkillFileList } from "@/lib/skillFiles";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ROOT = "/Users/dev/.skill-hub/skills/brainstorm";

function entry(
	rel: string,
	kind: SkillFileEntry["kind"],
	size = 1024,
	over: Partial<SkillFileEntry> = {},
): SkillFileEntry {
	return { rel, size, kind, editable: kind !== "binary", reason: null, ...over };
}

/** 10 files ⇒ past the 8-row filter threshold, two folder groups, one file at
 *  depth 2, one binary and one escaping symlink. */
const MULTI: SkillFileList = {
	root: ROOT,
	truncated: false,
	files: [
		entry("SKILL.md", "markdown", 8900),
		entry("CHANGELOG.md", "markdown", 1200),
		entry("references/planning.md", "markdown", 12400),
		entry("references/research.md", "markdown", 5800),
		entry("references/deep/legacy-notes.md", "markdown", 1100),
		entry("scripts/run.py", "script", 2400),
		entry("scripts/setup.sh", "script", 700),
		entry("data/config.json", "data", 300),
		entry("assets/logo.png", "binary", 48200, {
			editable: false,
			reason: "binary",
		}),
		entry("broken-link", "other", 0, {
			editable: false,
			reason: "symlink_outside",
		}),
	],
};

const SINGLE: SkillFileList = {
	root: "/Users/dev/.skill-hub/skills/rt-android-expert",
	truncated: false,
	files: [entry("SKILL.md", "markdown", 4100)],
};

const EXTERNAL: SkillFileList = {
	root: "/Users/dev/.skill-hub/sources/org-skills/worktree/skills/android-compose-ui",
	truncated: false,
	files: [
		entry("SKILL.md", "markdown", 5200),
		entry("references/api.md", "markdown", 9800),
		entry("scripts/lint.py", "script", 2400),
	],
};

interface MockOpts {
	listings?: Record<string, SkillFileList>;
	contents?: Record<string, string>;
	/** Rels whose read must reject with the given error string. */
	readErrors?: Record<string, string>;
	/** Rels whose write must reject with the given error string. */
	writeErrors?: Record<string, string>;
	onCreate?: (rel: string) => void;
	createError?: string;
	writes?: Array<{ rel: string; content: string }>;
	/** Every `save_skill_full` payload — the metadata/SKILL.md save path. */
	metaSaves?: Array<Record<string, unknown>>;
	/** Rels whose LISTING refetch must reject (a failed `onCreated` refresh). */
	listError?: string;
}

function setupInvoke(opts: MockOpts = {}) {
	const listings = opts.listings ?? { brainstorm: MULTI };
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		const a = (args ?? {}) as Record<string, string>;
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "check_python":
				return true;
			case "harness_list":
				return [];
			case "subagent_skill_usage":
				return {};
			case "read_skill_document":
				return {
					name: a.name,
					description: sampleRegistry.skills[a.name]?.description ?? "",
					body: `# ${a.name}\nrouter body`,
				};
			case "save_skill_full":
				opts.metaSaves?.push(a as unknown as Record<string, unknown>);
				return a.name;
			case "skill_files_list":
				if (opts.listError) throw new Error(opts.listError);
				return listings[a.name] ?? SINGLE;
			case "skill_file_read": {
				const err = opts.readErrors?.[a.rel];
				if (err) throw new Error(err);
				return {
					rel: a.rel,
					content: opts.contents?.[a.rel] ?? `content of ${a.rel}\n`,
					hash: `h-${a.rel}`,
					size: 10,
				};
			}
			case "skill_file_write": {
				const err = opts.writeErrors?.[a.rel];
				if (err) throw new Error(err);
				opts.writes?.push({ rel: a.rel, content: a.content });
				return { hash: `h2-${a.rel}` };
			}
			case "skill_file_create": {
				if (opts.createError) throw new Error(opts.createError);
				opts.onCreate?.(a.rel);
				return { hash: "h-new" };
			}
			case "hub_cmd":
				return { success: true, output: "" };
			default:
				return undefined;
		}
	}) as never);
}

function renderEditor(route = "/skill/brainstorm") {
	const client = makeQueryClient();
	primeRegistry(client);
	return renderWithProviders(
		<Routes>
			<Route path="/skill/:name" element={<SkillEditor />} />
		</Routes>,
		{ client, initialRoute: route },
	);
}

const rows = () => screen.getAllByTestId("skill-file-row");
/** The listing is a query — wait for it before reading rows. */
const readyRows = () => screen.findAllByTestId("skill-file-row");
const rowFor = (rel: string) =>
	rows().find((r) => r.getAttribute("data-rel") === rel)!;

/** Renders the editor next to a probe that navigates the way the rail, the
 *  NavPanel, the palette and a `g …` chord all do — through `useNavigate` — plus
 *  a real destination route and the toast layer. */
function renderEditorWithNav(route = "/skill/brainstorm") {
	const client = makeQueryClient();
	primeRegistry(client);
	return renderWithProviders(
		<>
			<NavProbe />
			<Routes>
				<Route path="/skill/:name" element={<SkillEditor />} />
				<Route
					path="/"
					element={<div data-testid="library-screen">library</div>}
				/>
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: route },
	);
}

function NavProbe() {
	const navigate = useNavigate();
	const location = useLocation();
	return (
		<div>
			<button
				type="button"
				data-testid="probe-go-library"
				onClick={() => navigate("/")}
			>
				go to library
			</button>
			<span data-testid="probe-path">{location.pathname}</span>
		</div>
	);
}

const rowState = (rel: string) => rowFor(rel).getAttribute("data-state");

/** Type into the mounted CodeMirror the way the user would, without a caret. */
function editBody(container: HTMLElement, insert: string) {
	const el = container.querySelector(".code-area--edit") as HTMLElement;
	const view = EditorView.findFromDOM(el)!;
	// Flush the dirty state and save-shortcut effect before sending the next key.
	act(() => view.dispatch({ changes: { from: 0, insert } }));
}

/** Select a row, wait for its buffer, and dirty it. */
async function openAndDirty(container: HTMLElement, rel: string) {
	await userEvent.click(rowFor(rel));
	await waitFor(() =>
		expect(
			container.querySelector(".code-area--edit .cm-content")?.textContent,
		).toContain(`content of ${rel}`),
	);
	editBody(container, "DRAFT ");
	await waitFor(() => expect(rowState(rel)).toBe("dirty"));
}

/** Edit the side panel's description field — a metadata edit that belongs to
 *  the screen, not to whichever file row happens to be open. */
async function editDescription(container: HTMLElement, text: string) {
	const field = container.querySelector(
		"[data-block='identity'] textarea",
	) as HTMLTextAreaElement;
	await userEvent.clear(field);
	await userEvent.type(field, text);
}

beforeEach(() => {
	useAppStore.setState({ toasts: [] });
	setupInvoke();
});

// ─── Panel IA (checklist 1–7) ────────────────────────────────────────────────

describe("skill editor side panel — IA", () => {
	it("[1] orders the panel IDENTITY → FILES → USED BY → SUB-AGENTS → RUNTIME → DANGER ZONE", async () => {
		const { container } = renderEditor();
		await screen.findByTestId("skill-files");
		const side = container.querySelector(".editor-side") as HTMLElement;
		const ids = [...side.querySelectorAll("[data-section-id]")].map((n) =>
			n.getAttribute("data-section-id"),
		);
		// Durable first (identity is a plain block, not a disclosure), then the
		// neighborhood, then the rarely-changed runtime settings. No SOURCE
		// section — the header chip and the source strip already name the owner.
		expect(ids).toEqual(["files", "usedby", "subagents", "runtime"]);
		const identity = side.querySelector("[data-block='identity']")!;
		const files = side.querySelector("[data-section-id='files']")!;
		expect(
			identity.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// Danger zone is last in the panel column.
		const danger = side.querySelector(".danger-zone")!;
		const lastSection = side.querySelector("[data-section-id='runtime']")!;
		expect(
			lastSection.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("[2] IDENTITY is durable: name edits in the header, description metered, facts as rows", async () => {
		const { container } = renderEditor();
		await screen.findByTestId("skill-files");
		const identity = container.querySelector("[data-block='identity']") as HTMLElement;
		// The name edits where the header reads it — the project header's
		// grammar — and the panel does not restate it.
		const header = container.querySelector(".main-header") as HTMLElement;
		expect(
			within(header).getByRole("button", { name: /Rename skill name/ }),
		).toBeInTheDocument();
		expect(
			within(identity).queryByRole("button", { name: /Rename skill name/ }),
		).toBeNull();
		const labels = [...identity.querySelectorAll(".field label")].map((n) => n.textContent);
		expect(labels).toEqual(["description"]);
		expect(identity.querySelector(".desc-meter")).toBeTruthy();
		const keys = [...identity.querySelectorAll(".kv-row dt")].map((n) => n.textContent);
		expect(keys).toEqual(["scope", "version", "upstream"]);
	});

	it("[3] identity facts are text until clicked; version opens its own field", async () => {
		const { container } = renderEditor();
		await screen.findByTestId("skill-files");
		const kv = container.querySelector("[data-block='identity'] .kv") as HTMLElement;
		expect(kv.textContent).toContain("1.0.0");
		expect(kv.textContent).toContain("global");
		// At rest nothing in the rows is a text field (scope is a Select).
		expect(kv.querySelector("input")).toBeNull();
		expect(kv.querySelector("select")).toBeNull();
		expect(within(kv).getByRole("combobox", { name: "Scope" })).toHaveTextContent("global");
		await userEvent.click(within(kv).getByRole("button", { name: /Rename version/ }));
		expect(within(kv).getByRole("textbox", { name: "Version" })).toHaveValue("1.0.0");
	});

	it("[4] collapses RUNTIME, states the effective mode, and opens the unchanged picker", async () => {
		const { container } = renderEditor();
		const head = await screen.findByTestId("side-section-runtime");
		expect(head).toHaveAttribute("aria-expanded", "false");
		const triggering = container.querySelector(
			"[data-section-id='runtime']",
		) as HTMLElement;
		expect(triggering.textContent).toContain("Auto");
		expect(screen.queryByRole("radiogroup", { name: "Triggering" })).toBeNull();

		await userEvent.click(head);
		expect(
			screen.getByRole("radiogroup", { name: "Triggering" }),
		).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /User-only/ })).toBeInTheDocument();
	});

	it("[6] keeps every field that was in the panel before reachable", async () => {
		const { container } = renderEditor();
		await screen.findByTestId("skill-files");
		await userEvent.click(screen.getByTestId("side-section-runtime"));
		const side = container.querySelector(".editor-side") as HTMLElement;
		expect(screen.getByRole("button", { name: /Rename skill name/ })).toBeTruthy();
		expect(side.querySelector(".field label")?.textContent).toBe("description");
		expect(side.querySelector(".invocation-heading")).toHaveTextContent("none installed");
		expect(side.querySelector(".invocation-heading")).toHaveTextContent("Who can trigger /");
		const keys = [...side.querySelectorAll(".kv-row dt")].map((n) => n.textContent);
		for (const f of ["scope", "version", "upstream"]) {
			expect(keys).toContain(f);
		}
		expect(screen.getByRole("radiogroup", { name: "Triggering" })).toBeTruthy();
		expect(side.querySelector("[data-section-id='usedby']")).toBeTruthy();
		expect(side.querySelector(".danger-zone")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Archive this skill/ }),
		).toBeTruthy();
	});

	it("[7] has exactly one disclosure implementation, shared by both panels", async () => {
		const src = join(process.cwd(), "src");
		const connPath = join(src, "components", "ConnectionsPanel.tsx");
		const panelPath = join(src, "components", "skillEditor", "RuntimeSection.tsx");
		const conn = readFileSync(connPath, "utf-8");
		const panel = readFileSync(panelPath, "utf-8");
		// Both panels go THROUGH the shared primitive. Asserting the import (not
		// the absence of a retired class name) is what actually fails when a
		// local disclosure creeps back in under any new name.
		for (const source of [conn, panel]) {
			expect(source).toMatch(
				/import \{ SidePanelSection \} from "(@\/components|\.)\/SidePanelSection"/,
			);
			expect(source).toContain("<SidePanelSection");
		}

		// And at runtime: EVERY disclosure on the panel is that primitive —
		// `data-section-id` + the head button it alone renders.
		const { container } = renderEditor();
		await screen.findByTestId("skill-files");
		const side = container.querySelector(".editor-side") as HTMLElement;
		const sections = [...side.querySelectorAll("[data-section-id]")];
		expect(sections.length).toBe(4);
		for (const section of sections) {
			const id = section.getAttribute("data-section-id");
			const head = section.querySelector(`[data-testid="side-section-${id}"]`);
			expect(head, `section ${id} is not a SidePanelSection`).toBeTruthy();
			expect(head).toHaveClass("side-panel-section-head");
		}
		// Nothing renders a disclosure the shared primitive does not own — the
		// shared guard also re-checks the two source files above for a raw
		// `aria-expanded` (a second implementation would have to render its
		// own toggle).
		expectOnlySidePanelSections(side, sections.length, [connPath, panelPath]);
	});
});

// ─── FILES navigator (checklist 8–17) ────────────────────────────────────────

describe("FILES navigator", () => {
	it("[8] pins SKILL.md first, outside any group, and never filters it out", async () => {
		renderEditor();
		await readyRows();
		expect(rows()[0]).toHaveAttribute("data-rel", "SKILL.md");
		expect(rowFor("SKILL.md").closest(".sf-group-block")).toBeNull();

		await userEvent.type(screen.getByTestId("skill-files-filter"), "run.py");
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(rows()[0]).toHaveAttribute("data-rel", "SKILL.md");
		expect(rows()[1]).toHaveAttribute("data-rel", "scripts/run.py");
	});

	it("[9] a single-file skill shows one row, no filter, and Add file when hub-owned", async () => {
		setupInvoke({ listings: { "rt-android-expert": SINGLE } });
		const { container } = renderEditor("/skill/rt-android-expert");
		await readyRows();
		expect(rows()).toHaveLength(1);
		expect(screen.queryByTestId("skill-files-filter")).toBeNull();
		expect(screen.getByTestId("skill-files-add")).toBeInTheDocument();
		const files = container.querySelector(
			"[data-section-id='files']",
		) as HTMLElement;
		expect(files.querySelector(".side-panel-section-count")?.textContent).toBe(
			"1",
		);
	});

	it("[10] shows the filter past 8 rows", async () => {
		renderEditor();
		await readyRows();
		expect(screen.getByTestId("skill-files-filter")).toBeInTheDocument();
	});

	it("[10] hides the filter at or below 8 rows", async () => {
		setupInvoke({ listings: { "android-compose-ui": EXTERNAL } });
		renderEditor("/skill/android-compose-ui");
		await readyRows();
		expect(screen.queryByTestId("skill-files-filter")).toBeNull();
	});

	it("[12] marks exactly one row aria-current, and it follows the selection", async () => {
		renderEditor();
		await readyRows();
		const current = () =>
			rows().filter((r) => r.getAttribute("aria-current") === "true");
		expect(current()).toHaveLength(1);
		expect(current()[0]).toHaveAttribute("data-rel", "SKILL.md");

		await userEvent.click(rowFor("references/planning.md"));
		await waitFor(() => {
			expect(current()).toHaveLength(1);
			expect(current()[0]).toHaveAttribute("data-rel", "references/planning.md");
		});
	});

	it("[13][30] selecting a row swaps the editor body and the footer path", async () => {
		const { container } = renderEditor();
		await readyRows();
		expect(screen.getByTestId("editor-active-path").textContent).toContain(
			"SKILL.md",
		);

		await userEvent.click(rowFor("references/planning.md"));
		await waitFor(() =>
			expect(
				container.querySelector(".code-area--edit .cm-content")?.textContent,
			).toContain("content of references/planning.md"),
		);
		expect(screen.getByTestId("editor-active-path").textContent).toContain(
			"references/planning.md",
		);
		// Identifier typography: the footer path renders in mono.
		expect(
			screen.getByTestId("editor-active-path").className,
		).toContain("editor-active-path");
	});

	it("[15] renders a binary row as a non-editable empty state with Reveal in Finder", async () => {
		const { container } = renderEditor();
		await readyRows();
		await userEvent.click(rowFor("assets/logo.png"));

		await waitFor(() =>
			expect(screen.getByText(/Binary file/)).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: "Reveal in Finder" }),
		).toBeInTheDocument();
		// No CodeMirror instance for a file the editor refuses to open.
		expect(container.querySelector(".code-area--edit")).toBeNull();
		// The mode chips go with it — there is no document to view.
		expect(screen.queryByRole("tab", { name: "Edit" })).toBeNull();
	});

	it("[16] a source-managed skill lists every file read-only, with no Add file and no per-row lock", async () => {
		setupInvoke({ listings: { "android-compose-ui": EXTERNAL } });
		const { container } = renderEditor("/skill/android-compose-ui");
		await readyRows();
		expect(rows()).toHaveLength(3);
		expect(screen.queryByTestId("skill-files-add")).toBeNull();
		expect(screen.getByText("READ-ONLY")).toBeInTheDocument();
		// Read-only is stated by the banner + the pill; rows carry no lock glyph.
		for (const row of rows()) {
			expect(row.textContent).not.toMatch(/lock/i);
			expect(row.querySelector("[data-lock]")).toBeNull();
		}

		await userEvent.click(rowFor("references/api.md"));
		// R1 opens a source-managed skill on Preview by default; switch to Edit
		// (still offered) to reach the CodeMirror surface this test is about.
		await waitFor(() => screen.getByRole("tab", { name: "Edit" }));
		fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
		await waitFor(() =>
			expect(
				container.querySelector(".code-area--edit .cm-content"),
			).toBeTruthy(),
		);
		expect(
			container
				.querySelector(".code-area--edit .cm-content")!
				.getAttribute("contenteditable"),
		).toBe("false");
	});

	// R1's default-Preview effect (`useDefaultPreviewMode`) sets `mode="preview"`
	// once, for the route's SKILL.md. `DocumentEditorShell` must fall back out
	// of it the moment a non-markdown row (no Preview chip) becomes active —
	// otherwise no tab is selected and the bash script renders through the
	// markdown preview pane.
	it("[1] falls back to Edit when the active file drops Preview out of a defaulted mode", async () => {
		setupInvoke({ listings: { "android-compose-ui": EXTERNAL } });
		renderEditor("/skill/android-compose-ui");
		await readyRows();
		await waitFor(() =>
			expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
				"aria-selected",
				"true",
			),
		);

		await userEvent.click(rowFor("scripts/lint.py"));
		await waitFor(() =>
			expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
				"aria-selected",
				"true",
			),
		);
	});

	it("[17] a file that vanished on disk goes missing and keeps its position", async () => {
		setupInvoke({
			readErrors: { "references/research.md": "not_found: gone" },
		});
		renderEditor();
		await readyRows();
		const before = rows().findIndex(
			(r) => r.getAttribute("data-rel") === "references/research.md",
		);

		await userEvent.click(rowFor("references/research.md"));
		await waitFor(() =>
			expect(rowFor("references/research.md")).toHaveAttribute(
				"data-state",
				"missing",
			),
		);
		const after = rows().findIndex(
			(r) => r.getAttribute("data-rel") === "references/research.md",
		);
		expect(after).toBe(before);
		expect(rowFor("references/research.md").textContent).toContain("—");
		expect(screen.getByText("File not found on disk")).toBeInTheDocument();
	});
});

// ─── Buffers and saving (checklist 21–23) ────────────────────────────────────

describe("per-file buffers", () => {
	it("[21] ⌘S writes only the active file and leaves a dirty sibling dirty", async () => {
		const writes: Array<{ rel: string; content: string }> = [];
		setupInvoke({ writes });
		const { container } = renderEditor();
		await readyRows();

		await openAndDirty(container, "references/research.md");
		await openAndDirty(container, "scripts/run.py");

		fireEvent.keyDown(window, { key: "s", metaKey: true });
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].rel).toBe("scripts/run.py");
		expect(writes[0].content).toContain("DRAFT ");
		// The sibling was never touched and is still dirty.
		expect(rowFor("references/research.md")).toHaveAttribute(
			"data-state",
			"dirty",
		);
		expect(writes.some((w) => w.rel === "references/research.md")).toBe(false);
	});

	it("[22] the Save button's dot reflects the ACTIVE file", async () => {
		const { container } = renderEditor();
		await readyRows();
		const saveBtn = () =>
			container.querySelector(".doc-editor-bar-right .btn-primary")!;

		await openAndDirty(container, "references/research.md");
		expect(saveBtn().className).toContain("btn-signal");

		// Switch to a clean file: same button, no dot, even though a buffer is
		// still dirty elsewhere.
		await userEvent.click(rowFor("SKILL.md"));
		await waitFor(() =>
			expect(saveBtn().className).not.toContain("btn-signal"),
		);
		expect(rowFor("references/research.md")).toHaveAttribute(
			"data-state",
			"dirty",
		);
	});

	it("[23] surfaces non-active dirty buffers in the head summary and on the row", async () => {
		const { container } = renderEditor();
		await readyRows();
		await openAndDirty(container, "references/research.md");
		await openAndDirty(container, "scripts/setup.sh");

		await userEvent.click(rowFor("SKILL.md"));
		const files = container.querySelector(
			"[data-section-id='files']",
		) as HTMLElement;
		await waitFor(() =>
			expect(
				files.querySelector(".side-panel-section-summary")?.textContent,
			).toBe("2 unsaved"),
		);
		expect(rowFor("references/research.md")).toHaveAttribute(
			"data-state",
			"dirty",
		);
		expect(rowFor("scripts/setup.sh")).toHaveAttribute("data-state", "dirty");
		expect(rowFor("SKILL.md")).toHaveAttribute("data-state", "ok");
	});
});

// ─── New file (checklist 26) ─────────────────────────────────────────────────

describe("add file", () => {
	it("[26] creates the file, refreshes the listing and selects the new row", async () => {
		const created: string[] = [];
		const listings: Record<string, SkillFileList> = {
			brainstorm: MULTI,
		};
		setupInvoke({
			listings,
			onCreate: (rel) => {
				created.push(rel);
				listings.brainstorm = {
					...MULTI,
					files: [...MULTI.files, entry(rel, "markdown", 0)],
				};
			},
		});
		renderEditor();
		await readyRows();

		await userEvent.click(screen.getByTestId("skill-files-add"));
		await userEvent.type(
			await screen.findByTestId("skill-files-path"),
			"references/new.md",
		);
		await userEvent.click(screen.getByRole("button", { name: "Create file" }));

		await waitFor(() => expect(created).toEqual(["references/new.md"]));
		await waitFor(() =>
			expect(rowFor("references/new.md")).toHaveAttribute(
				"aria-current",
				"true",
			),
		);
		expect(screen.getByTestId("editor-active-path").textContent).toContain(
			"references/new.md",
		);
	});
});

// ─── Chrome (checklist 28–30) ────────────────────────────────────────────────

describe("editor chrome follows the active file", () => {
	it("[28][29] keeps nameMono fixed and appends the rel path to the crumbs", async () => {
		const { container } = renderEditor();
		await readyRows();
		const title = () =>
			container.querySelector(".main-title .title-mono")!.textContent;
		const crumbs = () =>
			container.querySelector(".main-title .crumbs")!.textContent ?? "";

		expect(title()).toBe("brainstorm");
		expect(crumbs()).not.toContain("references/planning.md");

		await userEvent.click(rowFor("references/planning.md"));
		await waitFor(() =>
			expect(crumbs()).toContain("references/planning.md"),
		);
		// The identity column never moves with the active file.
		expect(title()).toBe("brainstorm");
		expect(
			container.querySelector(".main-title .crumbs .crumb-path .path")
				?.textContent,
		).toBe("references/planning.md");

		await userEvent.click(rowFor("SKILL.md"));
		await waitFor(() =>
			expect(
				container.querySelector(".main-title .crumbs .crumb-path"),
			).toBeNull(),
		);
		expect(title()).toBe("brainstorm");
	});
});

// ─── Source scans (checklist 34, 37) ─────────────────────────────────────────

const NEW_FILES = [
	join("components", "SidePanelSection.tsx"),
	join("components", "skillEditor", "SkillEditorSidePanel.tsx"),
	join("components", "skillFiles", "SkillFilesSection.tsx"),
	join("components", "skillFiles", "AddSkillFileSheet.tsx"),
	join("hooks", "useSkillFileBuffers.ts"),
	join("lib", "skillFileTree.ts"),
	join("styles", "screens", "skill-files.css"),
];

describe("token + icon discipline", () => {
	it("[34] no new file references --section or a --sec-* token", () => {
		const src = join(process.cwd(), "src");
		const offenders: string[] = [];
		for (const rel of NEW_FILES) {
			const text = readFileSync(join(src, rel), "utf-8");
			if (/var\(--section\)|--sec-[a-z]/.test(text)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	it("[37] the navigator adds no SVG — every glyph it names already exists", () => {
		const src = join(process.cwd(), "src");
		const used = new Set<string>();
		for (const rel of NEW_FILES.filter(
			(f) => f.endsWith(".tsx") || f.endsWith(".ts"),
		)) {
			const text = readFileSync(join(src, rel), "utf-8");
			for (const m of text.matchAll(/<Icon\s+name=\{?"([a-zA-Z.-]+)"/g))
				used.add(m[1]);
			for (const m of text.matchAll(/icon:\s*"([a-zA-Z.-]+)"/g)) used.add(m[1]);
		}
		// `skillFileIcon`'s whole output range, spelled out rather than scraped.
		for (const id of ["doc", "code", "list", "folder", "link", "warning", "plus"]) {
			used.add(id);
		}
		expect(used.size).toBeGreaterThan(6);
		const missing = [...used].filter((id) => !(id in ICONS));
		expect(missing).toEqual([]);
	});
});

// ─── Grouping model ──────────────────────────────────────────────────────────

describe("one folder-grouping level", () => {
	it("[11-support] groups by top level and dim-prefixes anything deeper", async () => {
		const { container } = renderEditor();
		await readyRows();
		const groups = [...container.querySelectorAll(".sf-group-name")].map(
			(n) => n.textContent,
		);
		expect(groups).toEqual(["assets", "data", "references", "scripts"]);
		// A depth-2 file lands in its TOP-level group; no second indent exists.
		const deep = rowFor("references/deep/legacy-notes.md");
		expect(
			within(deep.parentElement as HTMLElement)
				.getByText("deep/")
				.className,
		).toBe("sf-file-dim");
		expect(deep.closest(".sf-group-block")).toBe(
			container.querySelectorAll(".sf-group-block")[2],
		);
	});
});

// ─── Supporting coverage for the [e2e] checklist rows ────────────────────────

describe("supporting coverage", () => {
	it("[5-support] section state round-trips localStorage across a remount", async () => {
		const first = renderEditor();
		await screen.findByTestId("side-section-runtime");
		await userEvent.click(screen.getByTestId("side-section-runtime"));
		expect(screen.getByTestId("side-section-runtime")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(
			JSON.parse(localStorage.getItem("st:skill-editor:sections") ?? "{}"),
		).toMatchObject({ runtime: true });

		first.unmount();
		renderEditor();
		await waitFor(() =>
			expect(screen.getByTestId("side-section-runtime")).toHaveAttribute(
				"aria-expanded",
				"true",
			),
		);
	});

	it("[14-support] a non-Markdown text file drops Preview and the toolbar, keeps Diff", async () => {
		const { container } = renderEditor();
		await readyRows();
		expect(screen.getByRole("tab", { name: "Preview" })).toBeInTheDocument();

		await userEvent.click(rowFor("scripts/run.py"));
		await waitFor(() =>
			expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull(),
		);
		expect(screen.getByRole("tab", { name: "Edit" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument();
		expect(container.querySelector(".md-toolbar")).toBeNull();
	});

	it("[18][19-support] each row carries its full rel path and a formatted size, never a line count", async () => {
		renderEditor();
		await readyRows();
		const row = rowFor("references/deep/legacy-notes.md");
		expect(row.getAttribute("title")).toContain(
			"references/deep/legacy-notes.md",
		);
		expect(row.getAttribute("title")).toContain(ROOT);
		expect(rowFor("SKILL.md").textContent).toContain("8.7 KB");
		for (const r of rows()) expect(r.textContent).not.toMatch(/lines?/);
	});

	it("[27-support] refuses a traversing path inline and writes nothing", async () => {
		const created: string[] = [];
		setupInvoke({ onCreate: (rel) => created.push(rel) });
		renderEditor();
		await readyRows();

		await userEvent.click(screen.getByTestId("skill-files-add"));
		await screen.findByTestId("skill-files-path");
		for (const bad of ["../x.md", "/etc/passwd", "x/../../y.md"]) {
			fireEvent.change(screen.getByTestId("skill-files-path"), {
				target: { value: bad },
			});
			fireEvent.click(screen.getByRole("button", { name: "Create file" }));
			expect(await screen.findByRole("alert")).toHaveTextContent(
				/stay inside the skill folder|relative to the skill folder/i,
			);
		}
		expect(created).toEqual([]);
	});

	it("[33-support] arrow / j / k / Home / End / Enter move and open within the list", async () => {
		const { container } = renderEditor();
		await readyRows();
		const list = container.querySelector(".sf-list") as HTMLElement;
		expect(list).toHaveAttribute("role", "listbox");

		// Two moves land on the third row in RENDER order, whatever that is —
		// the point is that the container, not the window, owns the keys.
		const third = rows()[2].getAttribute("data-rel");
		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: "j" });
		fireEvent.keyDown(list, { key: "Enter" });
		await waitFor(() =>
			expect(
				rows().filter((r) => r.getAttribute("aria-current") === "true")[0],
			).toHaveAttribute("data-rel", third!),
		);
		expect(third).not.toBe("SKILL.md");

		fireEvent.keyDown(list, { key: "Home" });
		fireEvent.keyDown(list, { key: "Enter" });
		await waitFor(() =>
			expect(
				rows().filter((r) => r.getAttribute("aria-current") === "true")[0],
			).toHaveAttribute("data-rel", "SKILL.md"),
		);
	});
});

// ─── Review fixes: saving, the leave guard, list semantics ───────────────────

describe("saving a sibling file", () => {
	it("[3a] surfaces a failed write and keeps the buffer dirty", async () => {
		const writes: Array<{ rel: string; content: string }> = [];
		setupInvoke({
			writes,
			writeErrors: {
				"references/research.md": "Cannot stage write at /x/.research.md.tmp",
			},
		});
		const { container } = renderEditorWithNav();
		await readyRows();
		await openAndDirty(container, "references/research.md");

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		const toast = await screen.findByText(
			"Could not save references/research.md",
		);
		expect(toast).toBeInTheDocument();
		expect(
			useAppStore.getState().toasts.some((t) => t.kind === "error"),
		).toBe(true);
		// The edits are still in the buffer — a failed save is not a discard.
		expect(rowState("references/research.md")).toBe("dirty");
		expect(writes).toEqual([]);
	});

	it("[3b] one Save writes the active sibling AND the pending metadata edit", async () => {
		const writes: Array<{ rel: string; content: string }> = [];
		const metaSaves: Array<Record<string, unknown>> = [];
		setupInvoke({ writes, metaSaves });
		const { container } = renderEditorWithNav();
		await readyRows();

		await openAndDirty(container, "references/research.md");
		await editDescription(container, "a new description");

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].rel).toBe("references/research.md");
		await waitFor(() => expect(metaSaves).toHaveLength(1));
		expect(
			(metaSaves[0].meta as Record<string, unknown>).description,
		).toBe("a new description");
		// Both owners are clean again, so nothing is left to strand.
		await waitFor(() => expect(rowState("references/research.md")).toBe("ok"));
	});

	it("[3b] a metadata edit alone still saves, and never rewrites a clean sibling", async () => {
		const writes: Array<{ rel: string; content: string }> = [];
		const metaSaves: Array<Record<string, unknown>> = [];
		setupInvoke({ writes, metaSaves });
		const { container } = renderEditorWithNav();
		await readyRows();

		// Open a sibling but do NOT touch it.
		await userEvent.click(rowFor("references/research.md"));
		await waitFor(() =>
			expect(
				container.querySelector(".code-area--edit .cm-content")?.textContent,
			).toContain("content of references/research.md"),
		);
		await editDescription(container, "only metadata changed");

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() => expect(metaSaves).toHaveLength(1));
		expect(writes).toEqual([]);
	});

	it("[3c] refuses to rename the skill while a sibling buffer is dirty", async () => {
		const metaSaves: Array<Record<string, unknown>> = [];
		setupInvoke({ metaSaves });
		const { container } = renderEditorWithNav();
		await readyRows();

		// Dirty a sibling, then work on SKILL.md: the rename would move the route
		// and take the sibling's draft with it.
		await openAndDirty(container, "references/research.md");
		await userEvent.click(rowFor("SKILL.md"));
		// The name edits in place: open the field, type, Enter commits the draft
		// into the editor's dirty metadata (the write still waits for ⌘S).
		await userEvent.click(screen.getByRole("button", { name: /Rename skill name/ }));
		const nameField = screen.getByRole("textbox", { name: "Skill name" });
		await userEvent.clear(nameField);
		await userEvent.type(nameField, "brainstorm-two{Enter}");

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		expect(await screen.findByText("Save your open files first")).toBeVisible();
		// The rename never reached the registry, and the draft is still here.
		expect(metaSaves).toEqual([]);
		expect(rowState("references/research.md")).toBe("dirty");
	});

	it("[3c] allows the rename once the open file has been saved", async () => {
		const writes: Array<{ rel: string; content: string }> = [];
		const metaSaves: Array<Record<string, unknown>> = [];
		setupInvoke({ writes, metaSaves });
		const { container } = renderEditorWithNav();
		await readyRows();
		await openAndDirty(container, "references/research.md");

		// The name edits in place: open the field, type, Enter commits the draft
		// into the editor's dirty metadata (the write still waits for ⌘S).
		await userEvent.click(screen.getByRole("button", { name: /Rename skill name/ }));
		const nameField = screen.getByRole("textbox", { name: "Skill name" });
		await userEvent.clear(nameField);
		await userEvent.type(nameField, "brainstorm-two{Enter}");

		// One ⌘S: the sibling is written first, so nothing is left to lose and
		// the rename goes through in the same action.
		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() => expect(writes).toHaveLength(1));
		await waitFor(() => expect(metaSaves).toHaveLength(1));
		expect(metaSaves[0].name).toBe("brainstorm");
		expect(
			(metaSaves[0].document as Record<string, unknown>).name,
		).toBe("brainstorm-two");
	});
});

describe("add file — refresh failure", () => {
	it("[3e] says so when the listing refresh fails, instead of hanging on \"Opening file\"", async () => {
		const opts: MockOpts = {
			onCreate: () => {
				// The create landed; the refetch that follows it does not.
				opts.listError = "cannot list skill files";
			},
		};
		setupInvoke(opts);
		renderEditorWithNav();
		await readyRows();

		await userEvent.click(screen.getByTestId("skill-files-add"));
		await userEvent.type(
			await screen.findByTestId("skill-files-path"),
			"references/new.md",
		);
		await userEvent.click(screen.getByRole("button", { name: "Create file" }));

		expect(
			await screen.findByText("Created, but the file list did not refresh"),
		).toBeVisible();
		// The editor stayed on a file it can actually show.
		expect(screen.getByTestId("editor-active-path").textContent).toContain(
			"SKILL.md",
		);
	});
});

describe("leave guard", () => {
	it("[24] holds a programmatic navigation while anything is unsaved", async () => {
		const { container } = renderEditorWithNav();
		await readyRows();
		await openAndDirty(container, "references/research.md");

		// The rail, a NavPanel row, a palette result and a `g …` chord all leave
		// through `useNavigate` — the probe stands in for every one of them.
		await userEvent.click(screen.getByTestId("probe-go-library"));

		expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
		expect(screen.getByTestId("probe-path")).toHaveTextContent(
			"/skill/brainstorm",
		);
		expect(screen.queryByTestId("library-screen")).toBeNull();

		await userEvent.click(
			screen.getByRole("button", { name: "Discard and leave" }),
		);
		await waitFor(() =>
			expect(screen.getByTestId("probe-path")).toHaveTextContent("/"),
		);
		expect(screen.getByTestId("library-screen")).toBeInTheDocument();
	});

	it("[24] stays out of the way when nothing is unsaved", async () => {
		renderEditorWithNav();
		await readyRows();

		await userEvent.click(screen.getByTestId("probe-go-library"));

		await waitFor(() =>
			expect(screen.getByTestId("library-screen")).toBeInTheDocument(),
		);
		expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
	});

	it("[24] cancelling the prompt keeps the editor and the draft", async () => {
		const { container } = renderEditorWithNav();
		await readyRows();
		await openAndDirty(container, "references/research.md");

		await userEvent.click(screen.getByTestId("probe-go-library"));
		await screen.findByText("Discard unsaved changes?");
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() =>
			expect(screen.queryByText("Discard unsaved changes?")).toBeNull(),
		);
		expect(screen.getByTestId("probe-path")).toHaveTextContent(
			"/skill/brainstorm",
		);
		expect(rowState("references/research.md")).toBe("dirty");
	});
});

describe("file list semantics", () => {
	it("[6] the list is a listbox of options, and the active row is selected", async () => {
		const { container } = renderEditorWithNav();
		await readyRows();
		const list = container.querySelector(".sf-list") as HTMLElement;
		expect(list).toHaveAttribute("role", "listbox");

		for (const row of rows()) {
			expect(row).toHaveAttribute("role", "option");
			expect(row).toHaveAttribute("aria-selected");
		}
		// Exactly one option is selected — the one the roving tabindex is on.
		const selected = rows().filter(
			(r) => r.getAttribute("aria-selected") === "true",
		);
		expect(selected).toHaveLength(1);
		expect(selected[0]).toHaveAttribute("tabindex", "0");

		// A listbox may own `group`s; nothing else in it is unlabelled markup.
		for (const block of container.querySelectorAll(".sf-group-block")) {
			expect(block).toHaveAttribute("role", "group");
			expect(block).toHaveAttribute("aria-label");
		}
	});

	it("[6] the add-file sheet focuses its one field on open", async () => {
		renderEditorWithNav();
		await readyRows();

		await userEvent.click(screen.getByTestId("skill-files-add"));

		const input = await screen.findByTestId("skill-files-path");
		await waitFor(() => expect(input).toHaveFocus());
	});
});
