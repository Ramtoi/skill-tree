import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { HookActionEditor, type HookActionEditorProps } from "@/components/HookActionEditor";
import type { HookCommandScript } from "@/hooks/useHooks";
import { useAppStore } from "@/store";

// hook-editor-redesign D3/D6: a hook's action can now be a SCRIPT, and a managed
// script's body is an artifact on disk the editor owns. Two things must hold or
// the feature quietly destroys work:
//   * ⌘S is ONE action that lands the definition AND the body; a body-save
//     failure must never be reported as a clean save.
//   * switching away from a managed script DELETES the file, so it is gated by a
//     confirm that names the concrete path.

const CAPS = {
	schema_version: 1,
	probed_at: "2026-07-14T00:00:00Z",
	harnesses: {
		"claude-code": {
			harness_id: "claude-code",
			verdict: "supported",
			reason: "supported",
			extra: {},
		},
	},
};

const MANAGED_HOOK = {
	name: "format-on-write",
	provenance: "user",
	event: "PostToolUse",
	command: "",
	description: "Format written files",
	tools: ["Write"],
	matcher: "",
	timeout: null,
	harnesses: null,
	settings: {},
	attached_global: false,
	attached_projects: ["example-app"],
	project_settings: {},
	reach: {},
	script: { source: "managed", interpreter: "bash", args: "--quiet" },
};

const REPO_HOOK = {
	...MANAGED_HOOK,
	name: "repo-lint",
	script: { source: "repo", interpreter: "python3", path: "scripts/lint.py", args: "" },
	attached_projects: ["example-app", "moon-base"],
	script_projects: [
		{ project: "example-app", path_exists: true },
		{ project: "moon-base", path_exists: false },
	],
};

const COMMAND_HOOK = {
	...MANAGED_HOOK,
	name: "notify-on-stop",
	event: "Stop",
	command: "say done",
	script: null,
	script_projects: undefined,
};

const SCRIPT_BODY = "#!/usr/bin/env bash\necho formatting\n";

function mockEditor(over: Record<string, (args?: unknown) => unknown> = {}) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		if (cmd === "hook_capabilities") return Promise.resolve(CAPS);
		if (over[cmd]) return Promise.resolve(over[cmd](args));
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderEditor(route: string) {
	return renderWithProviders(
		<Routes>
			<Route path="/hook/:name" element={<HookEditor />} />
			<Route path="/hooks" element={<div>HOOKS-LIST</div>} />
		</Routes>,
		{ initialRoute: route, client: makeQueryClient() },
	);
}

/** Type into the CodeMirror script editor the way a user would (there is no
 *  textarea to fire a change event at). */
function typeInScript(text: string) {
	const el = document.querySelector(".hook-script-body .cm-editor") as HTMLElement;
	const view = EditorView.findFromDOM(el)!;
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: text },
		userEvent: "input.type",
	});
}

const errorToasts = () =>
	useAppStore.getState().toasts.filter((t) => t.kind === "error");

describe("HookActionEditor — mode derivation from the definition", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	it("a command hook opens in Shell command mode with a live textarea", async () => {
		mockEditor({ hook_show: () => COMMAND_HOOK });
		renderEditor("/hook/notify-on-stop");
		await waitFor(() =>
			expect(
				(screen.getByLabelText("command") as HTMLTextAreaElement).value,
			).toBe("say done"),
		);
		expect(screen.getByRole("radio", { name: "Shell command" })).toBeChecked();
		// A command hook never asks the backend for a script body.
		await waitFor(() =>
			expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
				"hook_script_show",
				expect.anything(),
			),
		);
	});

	it("a managed hook opens in Managed script mode and loads its body", async () => {
		mockEditor({
			hook_show: () => MANAGED_HOOK,
			hook_script_show: () => ({
				path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
				interpreter: "bash",
				body: SCRIPT_BODY,
			}),
		});
		renderEditor("/hook/format-on-write");

		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Managed script" })).toBeChecked(),
		);
		// Interpreter + args round-trip from the definition.
		expect(
			screen.getByRole("combobox", { name: "script interpreter" }),
		).toHaveTextContent("bash");
		expect((screen.getByLabelText("script args") as HTMLInputElement).value).toBe(
			"--quiet",
		);
		// The body reaches the editor, and the real on-disk path is shown (this is
		// the path a mode switch would delete).
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"echo formatting",
			),
		);
		expect(
			screen.getByText("/home/u/.skill-hub/hooks/format-on-write/script.sh"),
		).toBeInTheDocument();
	});

	it("a repo hook shows its path, interpreter, and per-project existence", async () => {
		mockEditor({ hook_show: () => REPO_HOOK });
		renderEditor("/hook/repo-lint");

		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Repo script" })).toBeChecked(),
		);
		expect((screen.getByLabelText("script path") as HTMLInputElement).value).toBe(
			"scripts/lint.py",
		);
		expect(
			screen.getByRole("combobox", { name: "script interpreter" }),
		).toHaveTextContent("python3");
		// Honest per-project reality: the hook is attached to two projects but the
		// file only exists in one.
		expect(screen.getByLabelText("example-app: script exists")).toBeInTheDocument();
		expect(screen.getByLabelText("moon-base: script missing")).toBeInTheDocument();
	});

	it("a managed hook whose file vanished says so instead of showing an empty editor", async () => {
		mockEditor({
			hook_show: () => MANAGED_HOOK,
			hook_script_show: () => ({ path: "/p/script.sh", interpreter: "bash", body: null }),
		});
		renderEditor("/hook/format-on-write");
		expect(
			await screen.findByText(/script file is missing on disk/),
		).toBeInTheDocument();
	});

	it("shows 'Synced as' with the baked command in place of the raw path (Wave B)", async () => {
		const baked = "'/usr/bin/bash' '/home/u/.skill-hub/hooks/format-on-write/script.sh' --quiet";
		mockEditor({
			hook_show: () => ({ ...MANAGED_HOOK, baked_command: baked }),
			hook_script_show: () => ({
				path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
				interpreter: "bash",
				body: SCRIPT_BODY,
			}),
		});
		renderEditor("/hook/format-on-write");

		expect(await screen.findByText(baked)).toBeInTheDocument();
		expect(screen.getByText(/Synced as:/)).toBeInTheDocument();
		expect(screen.queryByText(/Synced by absolute path/)).toBeNull();
	});
});

describe("HookActionEditor — repo path validation", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	it("shows an inline error for a traversal path and blocks the save", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_show: () => REPO_HOOK,
			hook_edit: (a) => {
				calls.push(a);
				return { success: true, output: "ok" };
			},
		});
		renderEditor("/hook/repo-lint");

		fireEvent.change(await screen.findByLabelText("script path"), {
			target: { value: "../../etc/evil.sh" },
		});
		// Inline, on the field — not an opaque CLI rejection after the round trip.
		expect(await screen.findByRole("alert")).toHaveTextContent(/escape/);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(errorToasts().length).toBe(1));
		expect(calls.length).toBe(0);
	});

	it("a valid path saves with the repo script fields", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_show: () => REPO_HOOK,
			hook_edit: (a) => {
				calls.push(a);
				return { success: true, output: "ok" };
			},
		});
		renderEditor("/hook/repo-lint");

		fireEvent.change(await screen.findByLabelText("script path"), {
			target: { value: "tools/lint.py" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({
			name: "repo-lint",
			scriptSource: "repo",
			scriptInterpreter: "python3",
			scriptPath: "tools/lint.py",
		});
		// A script hook never also ships a command — that shape is invalid.
		expect((calls[0] as { command?: unknown }).command).toBeNull();
	});
});

describe("HookActionEditor — managed body is saved with the form (D6)", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	function mockManaged(over: Record<string, (args?: unknown) => unknown> = {}) {
		mockEditor({
			hook_show: () => MANAGED_HOOK,
			hook_script_show: () => ({
				path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
				interpreter: "bash",
				body: SCRIPT_BODY,
			}),
			...over,
		});
	}

	async function openManaged() {
		renderEditor("/hook/format-on-write");
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"echo formatting",
			),
		);
	}

	it("editing the body alone marks the form UNSAVED and enables Save", async () => {
		mockManaged();
		await openManaged();
		expect(screen.queryByText("UNSAVED")).toBeNull();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

		typeInScript("#!/usr/bin/env bash\necho EDITED\n");

		// Script dirtiness feeds the SAME pill — there is no separate save dance.
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
	});

	it("⌘S saves the definition AND the body in one action", async () => {
		const edits: unknown[] = [];
		const bodies: unknown[] = [];
		mockManaged({
			hook_edit: (a) => {
				edits.push(a);
				return { success: true, output: "ok" };
			},
			hook_script_save: (a) => {
				bodies.push(a);
				return { success: true, output: "ok" };
			},
		});
		await openManaged();

		// typeInScript dispatches straight on the CodeMirror view (there is no
		// synthetic React event to fire), so the resulting setScriptBody /
		// setScriptBodyDirty update is NOT implicitly act()-scoped. Left
		// unwrapped, the ⌘S handler below reads a STALE closure: it is a
		// `window.addEventListener` re-subscribed by a passive effect keyed on
		// `scriptBodyDirty` (HookEditor.tsx's ⌘S effect), and that effect can
		// still be mid-flight — still holding `scriptBodyDirty: false` — at the
		// instant the synchronous `fireEvent.keyDown` below dispatches. When
		// that happens the keydown is silently swallowed: `dirty || scriptBodyDirty`
		// reads false, `save()` never runs, and `hook_script_save` never fires.
		// This IS the CI-only flake (reproduced deterministically in FLK-repro.txt
		// by firing the keydown with no yield at all after the raw dispatch) —
		// under CI load the same gap just widens enough to occasionally be hit.
		// act() forces the render AND its passive effects (incl. the listener
		// re-subscription) to settle before the next line runs, closing it.
		act(() => typeInScript("#!/usr/bin/env bash\necho EDITED\n"));
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());
		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() => expect(bodies.length).toBe(1));
		expect(edits.length).toBe(1);
		expect(edits[0]).toMatchObject({
			scriptSource: "managed",
			scriptInterpreter: "bash",
		});
		expect(bodies[0]).toEqual({
			name: "format-on-write",
			body: "#!/usr/bin/env bash\necho EDITED\n",
		});
		await waitFor(() => expect(screen.queryByText("UNSAVED")).toBeNull());
	});

	it("an unchanged body is NOT rewritten on save", async () => {
		const bodies: unknown[] = [];
		mockManaged({
			hook_edit: () => ({ success: true, output: "ok" }),
			hook_script_save: (a) => {
				bodies.push(a);
				return { success: true, output: "ok" };
			},
		});
		await openManaged();

		// Touch only a definition field.
		fireEvent.change(screen.getByLabelText("script args"), {
			target: { value: "--verbose" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByText("UNSAVED")).toBeNull());
		expect(bodies.length).toBe(0);
	});

	it("a failed body save keeps the form dirty and never claims success", async () => {
		mockManaged({
			hook_edit: () => ({ success: true, output: "ok" }),
			hook_script_save: () => ({ success: false, output: "permission denied" }),
		});
		await openManaged();

		typeInScript("echo EDITED\n");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(errorToasts().length).toBe(1));
		expect(errorToasts()[0].body).toContain("permission denied");
		expect(
			useAppStore.getState().toasts.some((t) => t.kind === "success"),
		).toBe(false);
		// The body is still unsaved on disk, so the pill must still say so.
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
	});
});

describe("HookActionEditor — switching away from a managed script (D6)", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	function mockManaged(over: Record<string, (args?: unknown) => unknown> = {}) {
		mockEditor({
			hook_show: () => MANAGED_HOOK,
			hook_script_show: () => ({
				path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
				interpreter: "bash",
				body: SCRIPT_BODY,
			}),
			...over,
		});
	}

	/** Render and WAIT for the on-disk script path to land. The confirm names
	 *  that path, so asserting before `hook_script_show` resolves would race the
	 *  create-mode fallback string. */
	async function openLoadedManaged() {
		renderEditor("/hook/format-on-write");
		await screen.findByText("/home/u/.skill-hub/hooks/format-on-write/script.sh");
	}

	it("gates the save behind a confirm that names the file being deleted", async () => {
		const calls: unknown[] = [];
		mockManaged({
			hook_edit: (a) => {
				calls.push(a);
				return { success: true, output: "ok" };
			},
		});
		await openLoadedManaged();

		fireEvent.click(screen.getByRole("radio", { name: "Shell command" }));
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("Delete the managed script?");
		// The concrete path, not a vague warning — this is not undoable.
		expect(dialog).toHaveTextContent(
			"/home/u/.skill-hub/hooks/format-on-write/script.sh",
		);
		// Nothing is written until the user confirms.
		expect(calls.length).toBe(0);
	});

	it("cancelling the confirm writes nothing and keeps the edit pending", async () => {
		const calls: unknown[] = [];
		mockManaged({
			hook_edit: (a) => {
				calls.push(a);
				return { success: true, output: "ok" };
			},
		});
		await openLoadedManaged();

		fireEvent.click(screen.getByRole("radio", { name: "Shell command" }));
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(calls.length).toBe(0);
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
	});

	it("confirming sends the CLEAR sentinel so the CLI drops the script block", async () => {
		const calls: unknown[] = [];
		mockManaged({
			hook_edit: (a) => {
				calls.push(a);
				return { success: true, output: "ok" };
			},
		});
		await openLoadedManaged();

		fireEvent.click(screen.getByRole("radio", { name: "Shell command" }));
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Delete script and save" }),
		);

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({
			name: "format-on-write",
			command: "echo hi",
			// `""` is the CLI's explicit clear; omitting it would leave the hook
			// carrying both a command and a script (an invalid definition).
			scriptSource: "",
		});
	});

	it("switching BETWEEN script kinds is still gated (the managed file still dies)", async () => {
		mockManaged({ hook_edit: () => ({ success: true, output: "ok" }) });
		await openLoadedManaged();

		fireEvent.click(screen.getByRole("radio", { name: "Repo script" }));
		fireEvent.change(screen.getByLabelText("script path"), {
			target: { value: "scripts/fmt.sh" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("dialog")).toHaveTextContent(
			"Delete the managed script?",
		);
	});

	it("editing a managed hook WITHOUT changing mode never shows the confirm", async () => {
		mockManaged({ hook_edit: () => ({ success: true, output: "ok" }) });
		await openLoadedManaged();

		fireEvent.change(screen.getByLabelText("script args"), {
			target: { value: "--verbose" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(screen.queryByText("UNSAVED")).toBeNull());
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("HookActionEditor — creating a managed-script hook", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	it("seeds a runnable stub and ships the body with hook_new", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_new: (a) => {
				calls.push(a);
				return { success: true, output: "created" };
			},
		});
		renderEditor("/hook/new");

		fireEvent.change(await screen.findByLabelText("hook name"), {
			target: { value: "fmt" },
		});
		fireEvent.click(screen.getByRole("radio", { name: "Managed script" }));
		// An empty script file would silently no-op at the first event.
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"#!/usr/bin/env bash",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Create hook" }));
		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({
			name: "fmt",
			scriptSource: "managed",
			scriptInterpreter: "bash",
		});
		expect(String((calls[0] as { scriptBody: string }).scriptBody)).toContain(
			"#!/usr/bin/env bash",
		);
		// A script hook must not also carry a command.
		expect((calls[0] as { command?: unknown }).command).toBeNull();
	});

	it("switching the interpreter rewrites an untouched stub but never a real script", async () => {
		mockEditor({ hook_new: () => ({ success: true, output: "ok" }) });
		renderEditor("/hook/new");

		fireEvent.click(await screen.findByRole("radio", { name: "Managed script" }));
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("bash"),
		);
		fireEvent.click(screen.getByRole("combobox", { name: "script interpreter" }));
		fireEvent.click(screen.getByRole("option", { name: "python3" }));
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("python3"),
		);

		// Now the user has actually written something — flipping back must not
		// throw their work away.
		typeInScript("print('mine')\n");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("combobox", { name: "script interpreter" }));
		fireEvent.click(screen.getByRole("option", { name: "bash" }));
		expect(document.querySelector(".cm-content")?.textContent).toContain("print('mine')");
	});
});

// ─── The managed body must never cross hooks (F3) ─────────────────────────────
// `App.tsx` renders `/hook/:name` WITHOUT a route key, so moving between hooks
// re-uses the same component instance and the same `scriptBody` state. The body
// hydration effect used to bail on `!payload` before checking identity, and for
// a command hook that payload never arrives (its script query is disabled) — so
// the previous hook's script sat in the buffer, kept the UNSAVED pill lit on a
// hook the user never touched, and ⌘S wrote it under the new hook's name.

describe("HookActionEditor — the managed body never leaks across hooks (F3)", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	const OTHER_MANAGED = {
		...MANAGED_HOOK,
		name: "other-managed",
		description: "Another managed hook",
	};

	function NavTo({ to, label }: { to: string; label: string }) {
		const navigate = useNavigate();
		return (
			<button type="button" onClick={() => navigate(to)}>
				{label}
			</button>
		);
	}

	function renderWithNav(to: string) {
		return renderWithProviders(
			<>
				<NavTo to={to} label="go next" />
				<Routes>
					<Route path="/hook/:name" element={<HookEditor />} />
				</Routes>
			</>,
			{ initialRoute: "/hook/format-on-write", client: makeQueryClient() },
		);
	}

	it("navigating from a dirty managed hook to a COMMAND hook drops the buffer, the pill, and never saves it there", async () => {
		const bodies: unknown[] = [];
		mockEditor({
			hook_show: (a) =>
				(a as { name?: string })?.name === "notify-on-stop"
					? COMMAND_HOOK
					: MANAGED_HOOK,
			hook_script_show: () => ({
				path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
				interpreter: "bash",
				body: SCRIPT_BODY,
			}),
			hook_edit: () => ({ success: true, output: "ok" }),
			hook_script_save: (a) => {
				bodies.push(a);
				return { success: true, output: "ok" };
			},
		});
		renderWithNav("/hook/notify-on-stop");

		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"echo formatting",
			),
		);
		typeInScript("#!/usr/bin/env bash\necho SECRET-A\n");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());

		fireEvent.click(screen.getByRole("button", { name: "go next" }));

		// The command hook is NOT unsaved — nothing on this screen was edited.
		await waitFor(() =>
			expect(
				(screen.getByLabelText("command") as HTMLTextAreaElement).value,
			).toBe("say done"),
		);
		expect(screen.queryByText("UNSAVED")).toBeNull();

		// Switching THIS hook to a managed script starts from the stub, not from
		// the other hook's script.
		fireEvent.click(screen.getByRole("radio", { name: "Managed script" }));
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"#!/usr/bin/env bash",
			),
		);
		expect(document.querySelector(".cm-content")?.textContent).not.toContain(
			"SECRET-A",
		);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bodies.length).toBe(1));
		expect(bodies[0]).toMatchObject({ name: "notify-on-stop" });
		expect(String((bodies[0] as { body: string }).body)).not.toContain("SECRET-A");
	});

	it("navigating between two MANAGED hooks never saves the first hook's body under the second", async () => {
		const bodies: unknown[] = [];
		// Set synchronously by the Promise executor below (never actually null by
		// the time the test releases it) — typed as a no-op so the call site is not
		// narrowed to `never`.
		let releaseSecond: () => void = () => {};
		mockEditor({
			hook_show: (a) =>
				(a as { name?: string })?.name === "other-managed"
					? OTHER_MANAGED
					: MANAGED_HOOK,
			hook_script_show: (a) => {
				if ((a as { name?: string })?.name === "other-managed") {
					// Still in flight while the user hits ⌘S — the window in which the
					// previous hook's buffer was the only thing on screen.
					return new Promise((resolve) => {
						releaseSecond = () =>
							resolve({
								path: "/home/u/.skill-hub/hooks/other-managed/script.sh",
								interpreter: "bash",
								body: "#!/usr/bin/env bash\necho other\n",
							});
					});
				}
				return {
					path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
					interpreter: "bash",
					body: SCRIPT_BODY,
				};
			},
			hook_edit: () => ({ success: true, output: "ok" }),
			hook_script_save: (a) => {
				bodies.push(a);
				return { success: true, output: "ok" };
			},
		});
		renderWithNav("/hook/other-managed");

		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"echo formatting",
			),
		);
		typeInScript("#!/usr/bin/env bash\necho SECRET-A\n");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());

		fireEvent.click(screen.getByRole("button", { name: "go next" }));
		// Wait for the second hook's DEFINITION to land (its body deliberately has
		// not) — asserting during the loading gate would pass for the wrong reason.
		await waitFor(() =>
			expect((screen.getByLabelText("description") as HTMLInputElement).value).toBe(
				"Another managed hook",
			),
		);
		// The second hook's body is still in flight: the editor must show no stale
		// body and claim no unsaved work.
		expect(screen.queryByText("UNSAVED")).toBeNull();
		expect(document.querySelector(".cm-content")?.textContent ?? "").not.toContain(
			"SECRET-A",
		);

		fireEvent.keyDown(window, { key: "s", metaKey: true });
		// Nothing is dirty, so ⌘S must not write a body at all — least of all the
		// previous hook's.
		await waitFor(() => expect(screen.queryByText("UNSAVED")).toBeNull());
		expect(bodies).toEqual([]);

		// Once the fetch lands, the SECOND hook's real body is what shows.
		releaseSecond();
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain(
				"echo other",
			),
		);
	});
});

// ─── Destructive copy names the real file, or none at all (F7/F8) ─────────────

describe("HookActionEditor — the managed script file in destructive copy", () => {
	beforeEach(() => useAppStore.setState({ toasts: [] }));

	it("the DELETE confirm names the managed script file, not just the attach scopes", async () => {
		mockEditor({
			hook_show: () => MANAGED_HOOK,
			hook_script_show: () => ({
				path: "/home/u/.skill-hub/hooks/format-on-write/script.sh",
				interpreter: "bash",
				body: SCRIPT_BODY,
			}),
		});
		renderEditor("/hook/format-on-write");
		await screen.findByText("/home/u/.skill-hub/hooks/format-on-write/script.sh");

		fireEvent.click(screen.getByRole("button", { name: "Delete this hook" }));
		const dialog = await screen.findByRole("dialog");
		// `hub hook delete` destroys the script too — the blast radius listed only
		// the scopes, so the one unrecoverable consequence went unmentioned.
		expect(dialog).toHaveTextContent("Will delete:");
		expect(dialog).toHaveTextContent(
			"/home/u/.skill-hub/hooks/format-on-write/script.sh",
		);
	});

	it("a COMMAND hook's delete confirm claims no script file", async () => {
		mockEditor({ hook_show: () => COMMAND_HOOK });
		renderEditor("/hook/notify-on-stop");
		await screen.findByLabelText("command");

		fireEvent.click(screen.getByRole("button", { name: "Delete this hook" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("Will detach from:");
		expect(dialog).not.toHaveTextContent("Will delete:");
	});

	it("create mode NEVER shows a composed absolute path (the data home is not ours to guess)", async () => {
		mockEditor();
		const { container } = renderEditor("/hook/new");
		await screen.findByLabelText("hook name");
		fireEvent.change(screen.getByLabelText("hook name"), {
			target: { value: "fmt" },
		});
		fireEvent.click(screen.getByRole("radio", { name: "Managed script" }));

		// `~/.skill-hub/hooks/fmt/script.sh` is a guess: the hooks dir follows
		// data_home(), which $SKILL_HUB_HOME moves. The section says what will
		// happen instead of naming a file that may never exist.
		expect(container.textContent).not.toContain(".skill-hub/hooks");
		expect(
			screen.getByText(/path assigned — when you save/),
		).toBeInTheDocument();
	});
});

// ─── Wave D: the script behind a command hook (read + convert) ───────────────

const COMMAND_SCRIPT: HookCommandScript = {
	token: "scripts/lint.sh",
	kind: "relative",
	locations: [
		{
			project: "example-app",
			path: "/Users/alice/dev/example-app/scripts/lint.sh",
			exists: true,
			body: "#!/bin/bash\necho lint\n",
			reason: null,
		},
		{
			project: "moon-base",
			path: "/Users/alice/dev/moon-base/scripts/lint.sh",
			exists: false,
			body: null,
			reason: null,
		},
	],
};

function baseActionEditorProps(
	over: Partial<HookActionEditorProps> = {},
): HookActionEditorProps {
	return {
		mode: "command",
		onModeChange: () => {},
		command: "bash scripts/lint.sh --fix",
		onCommandChange: () => {},
		interpreter: "bash",
		onInterpreterChange: () => {},
		scriptPath: "",
		onScriptPathChange: () => {},
		scriptArgs: "",
		onScriptArgsChange: () => {},
		body: "",
		onBodyChange: () => {},
		...over,
	};
}

describe("HookActionEditor — the script behind a command hook (Wave D)", () => {
	it("renders one row per location with its path, exists/missing badge, and Reveal only when it exists", async () => {
		const onReveal = vi.fn();
		render(
			<HookActionEditor
				{...baseActionEditorProps({ commandScript: COMMAND_SCRIPT, onReveal })}
			/>,
		);

		const rows = document.querySelectorAll(".hook-command-script-row");
		expect(rows.length).toBe(2);

		expect(screen.getByLabelText("example-app: script exists")).toBeInTheDocument();
		expect(screen.getByLabelText("moon-base: script missing")).toBeInTheDocument();
		expect(
			screen.getByText("/Users/alice/dev/example-app/scripts/lint.sh"),
		).toBeInTheDocument();

		// Only the row that exists offers Reveal.
		const revealButtons = screen.getAllByRole("button", { name: "Reveal" });
		expect(revealButtons.length).toBe(1);

		fireEvent.click(revealButtons[0]);
		expect(onReveal).toHaveBeenCalledWith(
			"/Users/alice/dev/example-app/scripts/lint.sh",
		);
	});

	it("shows the readable body and the missing-project fallback via SourceViewer", async () => {
		render(<HookActionEditor {...baseActionEditorProps({ commandScript: COMMAND_SCRIPT })} />);

		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo lint"),
		);
		fireEvent.click(screen.getByRole("tab", { name: "moon-base" }));
		expect(screen.getByText("Not present in moon-base.")).toBeInTheDocument();
	});

	it("shows the outside_project reason text via SourceViewer", () => {
		const script: HookCommandScript = {
			token: "../escape.sh",
			kind: "relative",
			locations: [
				{
					project: "alpha",
					path: "/Users/alice/dev/escape.sh",
					exists: false,
					body: null,
					reason: "outside_project",
				},
			],
		};
		render(<HookActionEditor {...baseActionEditorProps({ commandScript: script })} />);
		expect(
			screen.getByText("Resolves outside alpha — not shown."),
		).toBeInTheDocument();
	});

	it("shows the too_large reason text via SourceViewer, and still renders a tab for it", () => {
		const script: HookCommandScript = {
			token: "scripts/huge.sh",
			kind: "relative",
			locations: [
				{
					project: "alpha",
					path: "/Users/alice/dev/alpha/scripts/huge.sh",
					exists: true,
					body: null,
					reason: "too_large",
				},
			],
		};
		render(<HookActionEditor {...baseActionEditorProps({ commandScript: script })} />);
		expect(screen.getByRole("tab", { name: "alpha" })).toBeInTheDocument();
		expect(
			screen.getByText("Too large to show (over 512 KiB)."),
		).toBeInTheDocument();
	});

	it("offers no Script file block when command_script is absent", () => {
		render(<HookActionEditor {...baseActionEditorProps()} />);
		expect(document.querySelector(".hook-command-script")).toBeNull();
		// The three action-mode radios, no SourceViewer tabs.
		expect(screen.getAllByRole("radio").length).toBe(3);
		expect(screen.queryAllByRole("tab").length).toBe(0);
	});

	it("shows the convert offer only when a conversion is available and not read-only", () => {
		const onConvert = vi.fn();
		const { rerender } = render(
			<HookActionEditor
				{...baseActionEditorProps({
					conversion: { interpreter: "bash", path: "scripts/lint.sh", args: "--fix" },
					onConvert,
				})}
			/>,
		);
		expect(
			screen.getByText(/This command runs a script inside the project/),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Convert to repo script" }));
		expect(onConvert).toHaveBeenCalledTimes(1);

		rerender(<HookActionEditor {...baseActionEditorProps()} />);
		expect(
			screen.queryByText(/This command runs a script inside the project/),
		).toBeNull();
	});

	it("hides the convert offer when readOnly is set", () => {
		render(
			<HookActionEditor
				{...baseActionEditorProps({
					conversion: { interpreter: "bash", path: "scripts/lint.sh", args: "--fix" },
					readOnly: true,
				})}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Convert to repo script" })).toBeNull();
	});
});
