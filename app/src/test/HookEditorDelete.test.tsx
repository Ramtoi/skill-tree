import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { useAppStore } from "@/store";

// Delete is the ONE destructive, non-undoable hook action: it drops the
// definition AND detaches the hook from `hooks_global` + every
// `projects.<n>.hooks`. These tests pin the whole flow — the blast-radius list
// the confirm renders, that nothing fires before confirming, that the IPC
// carries `confirm: true` (a dropped flag turns the call into a CLI dry-run
// that reports success while nothing is deleted), the post-delete navigation,
// the failure toast, and the built-in variant that offers no Delete at all.

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
	attached_global: true,
	attached_projects: ["example-app", "moon-base"],
	project_settings: {},
	reach: {},
};

const BUILTIN_HOOK = {
	...USER_HOOK,
	name: "lsp-report",
	provenance: "builtin",
	event: "PostToolUse",
	command: "python3 lsp_report.py",
	attached_global: true,
	attached_projects: [] as string[],
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

describe("HookEditor — delete flow", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("names every scope the delete will detach from before confirming", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor("/hook/notify-on-stop");

		fireEvent.click(await screen.findByRole("button", { name: /Delete this hook/ }));

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent('Delete hook "notify-on-stop"?');
		// The blast radius enumerates global + each attached project.
		expect(dialog).toHaveTextContent("Will detach from:");
		expect(dialog).toHaveTextContent("global (all sessions)");
		expect(dialog).toHaveTextContent("project: example-app");
		expect(dialog).toHaveTextContent("project: moon-base");
		// Opening the confirm alone must NOT delete anything.
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"hook_delete",
			expect.anything(),
		);
	});

	it("says 'not attached anywhere' when the hook has no scopes", async () => {
		mockEditor({
			hook_show: () => ({
				...USER_HOOK,
				attached_global: false,
				attached_projects: [],
			}),
		});
		renderEditor("/hook/notify-on-stop");

		fireEvent.click(await screen.findByRole("button", { name: /Delete this hook/ }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("not attached anywhere");
		expect(dialog).not.toHaveTextContent("global (all sessions)");
	});

	it("cancelling the confirm fires no hook_delete", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor("/hook/notify-on-stop");

		fireEvent.click(await screen.findByRole("button", { name: /Delete this hook/ }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"hook_delete",
			expect.anything(),
		);
	});

	it("confirming deletes with confirm=true (never a silent dry run) and returns to the library", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_show: () => USER_HOOK,
			hook_delete: (args) => {
				calls.push(args);
				return { success: true, output: "deleted" };
			},
		});
		renderEditor("/hook/notify-on-stop");

		fireEvent.click(await screen.findByRole("button", { name: /Delete this hook/ }));
		fireEvent.click(
			await screen.findByRole("button", { name: /^Delete$/ }),
		);

		await waitFor(() => expect(calls.length).toBe(1));
		// `confirm: true` → the CLI's `--yes`; without it the delete is a dry run
		// that still reports success.
		expect(calls[0]).toEqual({ name: "notify-on-stop", confirm: true });
		// Success toast + navigation back to the library.
		await waitFor(() =>
			expect(screen.getByText("HOOKS-LIST")).toBeInTheDocument(),
		);
		expect(
			useAppStore
				.getState()
				.toasts.some(
					(t) => t.kind === "success" && /Deleted hook "notify-on-stop"/.test(t.title),
				),
		).toBe(true);
	});

	it("a failed delete surfaces an error toast and stays on the editor", async () => {
		mockEditor({
			hook_show: () => USER_HOOK,
			hook_delete: () => ({ success: false, output: "hook is a built-in" }),
		});
		renderEditor("/hook/notify-on-stop");

		fireEvent.click(await screen.findByRole("button", { name: /Delete this hook/ }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));

		await waitFor(() =>
			expect(
				useAppStore
					.getState()
					.toasts.some(
						(t) => t.kind === "error" && t.title === "Couldn't delete hook",
					),
			).toBe(true),
		);
		// No false "deleted" claim, and the editor is still mounted.
		expect(screen.queryByText("HOOKS-LIST")).toBeNull();
		expect(screen.getByLabelText("command")).toBeInTheDocument();
	});

	it("a built-in offers no Delete button and says why", async () => {
		mockEditor({ hook_show: () => BUILTIN_HOOK });
		renderEditor("/hook/lsp-report");

		await screen.findByLabelText("command");
		expect(screen.queryByRole("button", { name: /Delete this hook/ })).toBeNull();
		expect(
			screen.getByText(/Built-ins can't be deleted/),
		).toBeInTheDocument();
	});
});
