import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { parseGitSourceUrl } from "@/lib/skillSource";
import { Sources } from "@/screens/Sources";

// Source-scoped add: a pasted GitHub deep link must scope the scan to the
// directory it names, the preview must let the user curate WHICH new skills
// land, and a bad scan base must fail legibly instead of as four zeros.

interface Candidate {
	name: string;
	category: string;
	origin_path: string;
}

type ApplyCall = {
	args: string[];
	decisions: Record<string, string>;
	selectedNew: string[] | null;
};

/** Preview argv seen by the last `hub source add … --dry-run` call. */
let previewCalls: string[][] = [];
let applyCalls: ApplyCall[] = [];

function counts(cands: Candidate[]) {
	const of = (c: string) => cands.filter((x) => x.category === c).length;
	// The scanner's vocabulary (`classify_candidates`): NEW | CONFLICT |
	// IMPORTED | INVALID.
	return {
		new: of("NEW"),
		conflicts: of("CONFLICT"),
		imported: of("IMPORTED"),
		invalid: of("INVALID"),
	};
}

/** Stands in for the scanner: resolves the effective repo-relative base from
 *  argv (explicit `--path` wins) and answers for that base only. */
function previewFor(argv: string[]) {
	const pi = argv.indexOf("--path");
	const scanned = pi >= 0 ? argv[pi + 1] : "";
	if (scanned === "skills/unslop") {
		// `hint_path` mirrors the backend precondition (`_scan_base_hint`): it
		// exists ONLY when the URL carried a subpath and `<subpath>/<path>` is a
		// real directory. A plain repo URL gets the bare error.
		const urlSubpath = parseGitSourceUrl(argv[3] ?? "").subpath ?? "";
		const composed = urlSubpath ? `${urlSubpath}/${scanned}` : "";
		return {
			ok: false,
			error: "path_not_found",
			message: "skills/unslop does not exist in cursor/plugins@main.",
			...(composed === "pstack/skills/unslop" ? { hint_path: composed } : {}),
		};
	}
	if (scanned === "docs") {
		return { ok: true, scanned_path: scanned, counts: counts([]), candidates: [] };
	}
	if (scanned === "pstack/skills/unslop") {
		const cands: Candidate[] = [
			{ name: "unslop", category: "NEW", origin_path: "pstack/skills/unslop" },
		];
		return { ok: true, scanned_path: scanned, counts: counts(cands), candidates: cands };
	}
	const cands: Candidate[] = [
		{ name: "unslop", category: "NEW", origin_path: "pstack/skills/unslop" },
		{ name: "pstack-init", category: "NEW", origin_path: "pstack/skills/pstack-init" },
		{ name: "pstack-audit", category: "NEW", origin_path: "pstack/skills/pstack-audit" },
		{ name: "Bad Name", category: "INVALID", origin_path: "pstack/skills/Bad Name" },
	];
	return {
		ok: true,
		scanned_path: scanned || "",
		counts: counts(cands),
		candidates: cands,
	};
}

function mockBackend() {
	previewCalls = [];
	applyCalls = [];
	vi.mocked(invoke).mockImplementation((cmd: string, a?: unknown) => {
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		if (cmd === "source_add_apply") {
			applyCalls.push(a as ApplyCall);
			return Promise.resolve({
				ok: true,
				registered: ["unslop"],
				skipped: [],
				resolved: [],
				counts: { registered: 1 },
			});
		}
		if (cmd === "hub_cmd") {
			const argv = (a as { args: string[] }).args;
			if (argv[0] === "source" && argv[1] === "list") {
				return Promise.resolve({
					success: true,
					output: '{"sources":[],"errors":[]}',
				});
			}
			if (argv[0] === "source" && argv[1] === "add" && argv.includes("--dry-run")) {
				previewCalls.push(argv);
				const payload = previewFor(argv);
				return Promise.resolve({
					success: payload.ok,
					output: JSON.stringify(payload),
				});
			}
			return Promise.resolve({ success: true, output: "" });
		}
		return Promise.resolve(undefined);
	});
}

function urlField() {
	return screen.getByPlaceholderText("git@github.com:org/skills.git");
}
function pathField(): HTMLInputElement {
	return screen.getByTestId("source-path-input") as HTMLInputElement;
}
function idField(): HTMLInputElement {
	return screen.getByPlaceholderText("derived from URL") as HTMLInputElement;
}
function branchField(): HTMLInputElement {
	return screen.getByPlaceholderText("auto-detect") as HTMLInputElement;
}

function openWizard() {
	renderWithProviders(<Sources />, {
		client: makeQueryClient(),
		initialRoute: "/?add=1",
	});
}

const BLOB_URL =
	"https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md";
const TREE_URL = "https://github.com/cursor/plugins/tree/main/pstack/skills";

describe("Add source — deep-link scoping", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		mockBackend();
	});

	it("prefills branch, path and id from a /blob/ deep link", async () => {
		openWizard();
		fireEvent.change(urlField(), { target: { value: BLOB_URL } });

		await waitFor(() => expect(pathField().value).toBe("pstack/skills/unslop"));
		expect(branchField().value).toBe("main");
		// The source IS the deep-linked directory, not the monorepo it lives in.
		expect(idField().value).toBe("unslop");
		expect(screen.getByTestId("source-path-hint")).toHaveTextContent(
			"/pstack/skills/unslop",
		);
	});

	it("prefills from a /tree/ deep link and scopes the preview scan", async () => {
		openWizard();
		fireEvent.change(urlField(), { target: { value: TREE_URL } });
		await waitFor(() => expect(pathField().value).toBe("pstack/skills"));

		fireEvent.click(screen.getByRole("button", { name: "Preview" }));
		await screen.findByTestId("candidate-unslop");
		expect(previewCalls[0]).toContain("--path");
		expect(previewCalls[0][previewCalls[0].indexOf("--path") + 1]).toBe(
			"pstack/skills",
		);
		// Truth over echo: the summary shows what was actually scanned.
		expect(screen.getByTestId("scanned-path")).toHaveTextContent("/pstack/skills");
	});

	it("stops mirroring the URL once the path field is edited by hand", async () => {
		openWizard();
		fireEvent.change(urlField(), { target: { value: TREE_URL } });
		await waitFor(() => expect(pathField().value).toBe("pstack/skills"));
		fireEvent.change(pathField(), { target: { value: "other/dir" } });
		fireEvent.change(urlField(), { target: { value: BLOB_URL } });
		expect(pathField().value).toBe("other/dir");
	});
});

describe("Add source — per-skill selection", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		mockBackend();
	});

	async function previewThree() {
		openWizard();
		fireEvent.change(urlField(), { target: { value: TREE_URL } });
		await waitFor(() => expect(pathField().value).toBe("pstack/skills"));
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));
		await screen.findByTestId("candidate-unslop");
	}

	it("selects every NEW candidate by default and omits selected_new", async () => {
		await previewThree();
		expect(screen.getByLabelText("Import unslop")).toBeChecked();
		expect(screen.getByLabelText("Import pstack-init")).toBeChecked();
		// Nothing curated → plain Apply, no subset note.
		expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
		expect(screen.queryByTestId("subset-note")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(applyCalls).toHaveLength(1));
		// Absent means "import all" — the source keeps following upstream.
		expect(applyCalls[0].selectedNew).toBeNull();
	});

	it("shows an INVALID candidate without a checkbox and outside the count", async () => {
		await previewThree();
		const row = screen.getByTestId("candidate-Bad Name");
		expect(row).toHaveTextContent("INVALID");
		// Not selectable, and not part of "N of M" — it can never be imported.
		expect(screen.queryByLabelText("Import Bad Name")).toBeNull();
		expect(screen.getByText("1 invalid")).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("Import pstack-audit"));
		expect(await screen.findByRole("button", { name: "Import 2 of 3" })).toBeInTheDocument();
	});

	it("sends only the checked skills when a subset is curated", async () => {
		await previewThree();
		fireEvent.click(screen.getByLabelText("Import pstack-audit"));

		const apply = await screen.findByRole("button", { name: "Import 2 of 3" });
		expect(screen.getByTestId("subset-note")).toHaveTextContent("Importing 2 of 3");

		fireEvent.click(apply);
		await waitFor(() => expect(applyCalls).toHaveLength(1));
		expect(applyCalls[0].selectedNew).toEqual(["unslop", "pstack-init"]);
	});

	it("select none blocks Apply with a reason, select all re-arms it", async () => {
		await previewThree();
		fireEvent.click(screen.getByTestId("select-all-new"));

		const apply = screen.getByTestId("source-apply");
		await waitFor(() => expect(apply).toHaveAttribute("aria-disabled", "true"));
		// The count never lies, not even at zero.
		expect(apply).toHaveTextContent("Import 0 of 3");
		expect(apply).toHaveAttribute("title", "Select at least one skill to import.");

		fireEvent.click(screen.getByTestId("select-all-new"));
		await waitFor(() =>
			expect(screen.getByTestId("source-apply")).not.toHaveAttribute(
				"aria-disabled",
				"true",
			),
		);
		expect(screen.getByTestId("source-apply")).toHaveTextContent("Apply");
	});
});

describe("Add source — honest failure states", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		mockBackend();
	});

	it("surfaces path_not_found and re-previews with the suggested path", async () => {
		openWizard();
		// A deep link carries the subpath you were browsing — the only thing that
		// can turn a wrong path into a suggestion (backend `_scan_base_hint`).
		fireEvent.change(urlField(), {
			target: { value: "https://github.com/cursor/plugins/tree/main/pstack" },
		});
		await waitFor(() => expect(pathField().value).toBe("pstack"));
		// A path copied from the page you were reading — relative to that subpath.
		fireEvent.change(pathField(), { target: { value: "skills/unslop" } });
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		const card = await screen.findByTestId("source-path-error");
		// sources.journey.spec.ts "the wizard names a bad scan path and fixes
		// it in one click" (~:280): the ErrorCard's own `title` prop (an <h2>,
		// not an HTML `title` attribute — AddSourceModal.tsx ~:410).
		expect(card).toHaveTextContent("That path isn't in the repository");
		expect(card).toHaveTextContent("does not exist");
		expect(card).toHaveTextContent("pstack/skills/unslop");
		// No preview step was entered — the fix belongs next to the field.
		expect(screen.queryByTestId("scanned-path")).toBeNull();

		fireEvent.click(screen.getByTestId("use-hint-path"));
		await screen.findByTestId("candidate-unslop");
		const last = previewCalls[previewCalls.length - 1];
		expect(last[last.indexOf("--path") + 1]).toBe("pstack/skills/unslop");
		expect(screen.getByTestId("scanned-path")).toHaveTextContent(
			"/pstack/skills/unslop",
		);
	});

	it("offers no suggestion when the URL carries no subpath to compose one from", async () => {
		openWizard();
		fireEvent.change(urlField(), {
			target: { value: "https://github.com/cursor/plugins" },
		});
		fireEvent.change(pathField(), { target: { value: "skills/unslop" } });
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		const card = await screen.findByTestId("source-path-error");
		expect(card).toHaveTextContent("does not exist");
		// Nothing to suggest → no one-click fix is offered (and none is invented).
		expect(screen.queryByTestId("use-hint-path")).toBeNull();
	});

	it("says the path is empty instead of showing four zeros", async () => {
		openWizard();
		fireEvent.change(urlField(), {
			target: { value: "https://github.com/cursor/plugins" },
		});
		fireEvent.change(pathField(), { target: { value: "docs" } });
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		expect(await screen.findByText(/No skills found at/)).toBeInTheDocument();
		expect(screen.getByTestId("scanned-path")).toHaveTextContent("/docs");
		// Nothing to import → Apply stays inert with a reason.
		const apply = screen.getByRole("button", { name: "Apply" });
		expect(apply).toHaveAttribute("aria-disabled", "true");
		expect(apply).toHaveAttribute(
			"title",
			"Choose a conflict resolution or import at least one new skill.",
		);
	});
});

describe("Sources list — curated source", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		vi.mocked(invoke).mockImplementation((cmd: string) => {
			if (cmd === "read_registry")
				return Promise.resolve({
					...sampleRegistry,
					sources: {
						...sampleRegistry.sources,
						curated: {
							type: "git",
							name: "Curated",
							url: "https://github.com/cursor/plugins",
							branch: "main",
							path: "pstack/skills",
							include: ["unslop", "pstack-init"],
							status: "up-to-date",
							error: null,
						},
					},
				});
			if (cmd === "hub_cmd")
				return Promise.resolve({ success: true, output: "" });
			return Promise.resolve(undefined);
		});
	});

	it("marks a source whose membership is filtered by include", async () => {
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/",
		});
		const tag = await screen.findByTestId("source-filtered-curated");
		expect(tag).toHaveTextContent("Filtered · 2");
		expect(tag).toHaveAttribute(
			"title",
			"Only these upstream skills are imported: unslop, pstack-init",
		);
	});
});
