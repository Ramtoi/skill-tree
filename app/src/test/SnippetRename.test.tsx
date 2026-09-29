import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SnippetEditor } from "@/screens/SnippetEditor";
import { useAppStore } from "@/store";
import type { SnippetInfo } from "@/types/snippets";
import { deferredInvoke, renderWithProviders, sampleRegistry } from "./helpers";

/** Renders the current location's pathname — proves a navigation actually
 *  landed, same pattern `LibraryBundleMode.test.tsx` uses for its own header
 *  rename. A PERMANENT sibling, not a catch-all route: a rename lands on
 *  `/snippet/<new>`, which still matches the SAME `/snippet/:name` route, so
 *  a wildcard `*` route would never mount to report it. */
function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname}</div>;
}

const LIB: SnippetInfo[] = [
	{
		name: "android-conventions",
		description: "Project conventions.",
		tags: ["android"],
		version: 2,
		created: "",
		updated: "today",
		hash: "a1b2c3d4",
		usage: { count: 0, summary: "none", outdated_count: 0 },
	},
	{
		name: "commit-message-format",
		description: "Commit format.",
		tags: ["git"],
		version: 1,
		created: "",
		updated: "1w ago",
		hash: "ee99ff00",
		usage: { count: 0, summary: "none", outdated_count: 0 },
	},
];

/** `snippet_show` echoes back whichever name it was asked for — the fixture
 *  itself never needs to be mutated by a rename, unlike the VISUAL_MOCK's
 *  `tauriCore.ts` (which has to answer OTHER consumers too). Falls back to
 *  LIB[0] for a renamed-to name that isn't itself in LIB, so the ordinary
 *  rename tests keep seeing android-conventions' own fields; a name that
 *  DOES match an existing LIB entry (used to prove a THIRD, unrelated
 *  snippet's own data loaded — see the C2(a) test) gets its own fields. */
function showFor(name: string) {
	const base = LIB.find((s) => s.name === name) ?? LIB[0];
	return {
		...base,
		name,
		body: `## Body\n\n${base.description}\n`,
		usage: { count: 0, summary: "none" as const, outdated_count: 0, locations: [] },
	};
}

/** Captures every `hub_cmd` argv (same shape as `LibraryBundleMode.test.tsx`'s
 *  `mockHub`) and answers the rest of the editor's fetches so the whole
 *  screen mounts without needing a per-test mock for every IPC call. */
function mockSnippetBackend(
	override?: (a: string[]) => { success: boolean; output: string } | undefined,
) {
	const calls: string[][] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "hub_cmd") {
			const a = (args as { args: string[] }).args;
			calls.push(a);
			return override?.(a) ?? { success: true, output: "" };
		}
		switch (cmd) {
			case "snippets_list":
				return LIB;
			case "snippet_show":
				return showFor((args as { name: string }).name);
			case "snippet_status":
				return { locations: [], damaged: [] };
			case "read_registry":
				return sampleRegistry;
			default:
				return undefined;
		}
	}) as never);
	return calls;
}

function renderEditor(initialRoute: string) {
	return renderWithProviders(
		<>
			<LocationProbe />
			<Routes>
				<Route path="/snippet/:name" element={<SnippetEditor />} />
			</Routes>
		</>,
		{ initialRoute },
	);
}

describe("SnippetEditor — header rename", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("shows the rename affordance in the header", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");
		expect(
			await screen.findByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		).toBeInTheDocument();
	});

	it("renames through `hub snippet rename` and navigates to the new route", async () => {
		const calls = mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		await userEvent.click(
			await screen.findByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(calls).toContainEqual([
				"snippet",
				"rename",
				"android-conventions",
				"android-guidelines",
				"--json",
			]),
		);
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent(
				"/snippet/android-guidelines",
			),
		);
	});

	it("an invalid draft disables Save and never calls hub_cmd", async () => {
		const calls = mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		await userEvent.click(
			await screen.findByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "Bad Name!");

		expect(field).toHaveAttribute("aria-invalid", "true");
		const saveBtn = screen.getByRole("button", { name: "Save" });
		expect(saveBtn).toHaveAttribute("aria-disabled", "true");

		await userEvent.keyboard("{Enter}");
		expect(calls.some((a) => a[0] === "snippet" && a[1] === "rename")).toBe(
			false,
		);
	});

	it("blocks a name another snippet already holds", async () => {
		const calls = mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		await userEvent.click(
			await screen.findByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "commit-message-format");

		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(field).toHaveAttribute(
			"title",
			'A snippet named "commit-message-format" already exists.',
		);

		await userEvent.keyboard("{Enter}");
		expect(calls.some((a) => a[0] === "snippet" && a[1] === "rename")).toBe(
			false,
		);
	});

	it("preserves a dirty description buffer across the rename navigation", async () => {
		const calls = mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		const descInput = await screen.findByPlaceholderText(
			"One line — what this snippet instructs",
		);
		fireEvent.change(descInput, { target: { value: "A hand-edited description." } });

		await userEvent.click(
			screen.getByRole("button", { name: "Rename snippet name: android-conventions" }),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(calls).toContainEqual([
				"snippet",
				"rename",
				"android-conventions",
				"android-guidelines",
				"--json",
			]),
		);
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent(
				"/snippet/android-guidelines",
			),
		);
		// The `setLoadedFor` pre-stage trick: the load effect must not have
		// reset the buffer once the (differently-named) fetch under the new
		// route lands — wait for that fetch to resolve, then check the value.
		expect(
			await screen.findByPlaceholderText("One line — what this snippet instructs"),
		).toHaveValue("A hand-edited description.");
	});

	it("H1: warns when the rename landed but couldn't rewrite every location", async () => {
		mockSnippetBackend((a) =>
			a[0] === "snippet" && a[1] === "rename"
				? {
						success: true,
						output: JSON.stringify({
							action: "rename",
							from: a[2],
							to: a[3],
							renamed: [],
							errors: [{ project: "demo2", rel: "AGENTS.md", error: "damaged marker" }],
						}),
					}
				: undefined,
		);
		renderEditor("/snippet/android-conventions");

		await userEvent.click(
			await screen.findByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() => {
			const titles = useAppStore.getState().toasts.map((t) => t.title);
			expect(titles).toContain(
				"Renamed, but 1 location couldn't be rewritten",
			);
		});
	});

	it("M2: a rename attempted while a save is in flight throws, toasts, and keeps the field open", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");
		const descInput = await screen.findByPlaceholderText(
			"One line — what this snippet instructs",
		);
		fireEvent.change(descInput, { target: { value: "Edited description." } });

		const gate = deferredInvoke((cmd) => cmd === "snippet_edit");
		const saveBtn = screen.getByRole("button", {
			name: (name) => name.replace(/ ⌘S$/, "") === "Save",
		});
		fireEvent.click(saveBtn);
		await waitFor(() => expect(saveBtn).toHaveAttribute("aria-busy", "true"));

		await userEvent.click(
			screen.getByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() => {
			const titles = useAppStore.getState().toasts.map((t) => t.title);
			expect(titles).toContain("Can't rename right now");
		});
		// InlineName never closed the field — the draft is still there, not
		// silently discarded (the old bug: a plain `return` resolves the
		// promise, which `commit()` treats as a completed save).
		expect(screen.getByRole("textbox", { name: "Snippet name" })).toHaveValue(
			"android-guidelines",
		);
		expect(
			vi
				.mocked(invoke)
				.mock.calls.some(
					(c) =>
						c[0] === "hub_cmd" &&
						(c[1] as { args: string[] }).args[1] === "rename",
				),
		).toBe(false);

		await act(async () => {
			gate.resolve({
				...showFor("android-conventions"),
				body_changed: true,
				outdated_locations: 0,
			});
		});
	});

	it("C2(a): navigating to a different snippet mid-rename does not strand the loader forever", async () => {
		mockSnippetBackend();

		function GoElsewhere() {
			const navigate = useNavigate();
			return (
				<button onClick={() => navigate("/snippet/commit-message-format")}>
					go-elsewhere
				</button>
			);
		}
		renderWithProviders(
			<>
				<LocationProbe />
				<GoElsewhere />
				<Routes>
					<Route path="/snippet/:name" element={<SnippetEditor />} />
				</Routes>
			</>,
			{ initialRoute: "/snippet/android-conventions" },
		);

		await screen.findByRole("button", {
			name: "Rename snippet name: android-conventions",
		});
		// Gate the RENAMED name's own fetch so it is still in flight — the
		// exact race window C2(a) describes — when we navigate away below.
		const gate = deferredInvoke(
			(cmd, args) =>
				cmd === "snippet_show" &&
				(args as { name?: string } | undefined)?.name === "android-guidelines",
		);

		await userEvent.click(
			screen.getByRole("button", {
				name: "Rename snippet name: android-conventions",
			}),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent(
				"/snippet/android-guidelines",
			),
		);

		// Navigate away to a THIRD, unrelated snippet before the renamed
		// name's own fetch ever resolves.
		fireEvent.click(screen.getByRole("button", { name: "go-elsewhere" }));
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent(
				"/snippet/commit-message-format",
			),
		);

		// The old bug: `pendingRenameRef` stayed set forever once it stopped
		// matching `snippet.name`, so the load effect returned early on every
		// later render and no snippet ever loaded again. Prove the fix: this
		// THIRD snippet's own (distinct) description actually paints.
		await waitFor(() =>
			expect(
				screen.getByPlaceholderText("One line — what this snippet instructs"),
			).toHaveValue("Commit format."),
		);

		await act(async () => {
			gate.resolve(showFor("android-guidelines"));
		});
	});
});
