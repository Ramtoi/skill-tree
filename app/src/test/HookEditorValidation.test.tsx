import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { useAppStore } from "@/store";

// Core-field save: the guards that keep a malformed definition from reaching
// `hub hook new/edit`, and the honesty contract on failure — a CLI rejection
// must NOT clear the UNSAVED pill or claim a save happened (the silent-success
// illusion). The existing HookEditor suite covers only the happy path plus the
// *settings* failure branch.

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

const USER_HOOK = {
	name: "notify-on-stop",
	provenance: "user",
	event: "Stop",
	command: "say done",
	description: "",
	tools: [] as string[],
	matcher: "",
	timeout: null,
	harnesses: null,
	settings: {},
	attached_global: false,
	attached_projects: [] as string[],
	project_settings: {},
	reach: {},
};

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

function errorToasts() {
	return useAppStore.getState().toasts.filter((t) => t.kind === "error");
}

describe("HookEditor — create-mode validation", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("blocks an invalid slug before any IPC and says what a name may contain", async () => {
		mockEditor();
		renderEditor("/hook/new");

		fireEvent.change(await screen.findByLabelText("hook name"), {
			target: { value: "Bad Name" },
		});
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create hook" }));

		await waitFor(() => expect(errorToasts().length).toBe(1));
		expect(errorToasts()[0].title).toMatch(
			/Hook name must use lowercase letters, numbers, and hyphens/,
		);
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"hook_new",
			expect.anything(),
		);
		// The form is still dirty — nothing was saved.
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
	});

	it("blocks an empty command before any IPC", async () => {
		mockEditor();
		renderEditor("/hook/new");

		fireEvent.change(await screen.findByLabelText("hook name"), {
			target: { value: "lint-x" },
		});
		// Command left blank (whitespace only is still empty).
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create hook" }));

		await waitFor(() => expect(errorToasts().length).toBe(1));
		expect(errorToasts()[0].title).toBe("Command is required");
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"hook_new",
			expect.anything(),
		);
	});

	it("never forwards a non-numeric timeout to the CLI", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_new: (args) => {
				calls.push(args);
				return { success: true, output: "created" };
			},
		});
		renderEditor("/hook/new");

		fireEvent.change(await screen.findByLabelText("hook name"), {
			target: { value: "lint-x" },
		});
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		const timeoutInput = screen.getByLabelText("timeout") as HTMLInputElement;
		fireEvent.change(timeoutInput, { target: { value: "soon" } });
		// `<input type="number">` sanitizes garbage to "" (jsdom and browsers
		// agree), so the field itself is the first line of defence; the editor's
		// NaN guard is the belt behind it. Either way `hub hook new` must never
		// receive a non-numeric --timeout.
		expect(timeoutInput.value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "Create hook" }));
		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({ name: "lint-x", timeout: null });
		expect(errorToasts()).toEqual([]);
	});

	it("a numeric timeout reaches hook_new as a number", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_new: (args) => {
				calls.push(args);
				return { success: true, output: "created" };
			},
		});
		renderEditor("/hook/new");

		fireEvent.change(await screen.findByLabelText("hook name"), {
			target: { value: "lint-x" },
		});
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		fireEvent.change(screen.getByLabelText("timeout"), {
			target: { value: "45" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create hook" }));

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({ name: "lint-x", timeout: 45 });
	});
});

describe("HookEditor — save failure honesty", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("a rejected hook_new toasts the failure, keeps UNSAVED, and does not navigate", async () => {
		mockEditor({
			hook_new: () => ({ success: false, output: "hook 'lint-x' already exists" }),
		});
		renderEditor("/hook/new");

		fireEvent.change(await screen.findByLabelText("hook name"), {
			target: { value: "lint-x" },
		});
		fireEvent.change(screen.getByLabelText("command"), {
			target: { value: "echo hi" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create hook" }));

		await waitFor(() => expect(errorToasts().length).toBe(1));
		expect(errorToasts()[0].title).toBe("Couldn't save hook");
		expect(errorToasts()[0].body).toContain("already exists");
		// No success toast, the pill is still UNSAVED, and we stayed on create.
		expect(
			useAppStore.getState().toasts.some((t) => t.kind === "success"),
		).toBe(false);
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		expect(screen.getByLabelText("hook name")).toBeInTheDocument();
	});

	it("a rejected hook_edit toasts the failure and keeps the form dirty", async () => {
		mockEditor({
			hook_show: () => USER_HOOK,
			hook_edit: () => ({ success: false, output: "unknown event" }),
		});
		renderEditor("/hook/notify-on-stop");

		fireEvent.change(await screen.findByLabelText("command"), {
			target: { value: "say done --loud" },
		});
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(errorToasts().length).toBe(1));
		expect(errorToasts()[0].title).toBe("Couldn't save hook");
		// The edit is NOT presented as saved — the pill survives so the user knows
		// the change is still pending.
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		expect(
			useAppStore.getState().toasts.some((t) => t.kind === "success"),
		).toBe(false);
	});
});
