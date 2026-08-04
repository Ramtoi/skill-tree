import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { useAppStore } from "@/store";

// GenericSettingsEditor is the settings UI EVERY non-lsp-report hook gets (i.e.
// every user-authored hook — lsp-report is the single built-in). The existing
// settings tests all use lsp-report, which renders LspLanguageTable instead, so
// this component had never been rendered by a test. What it ships to
// `hub hook set-settings --json` is deep-merged into the registry, so a
// malformed payload is a real config hazard.

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
	settings: { voice: "Daniel", retries: 2 },
	attached_global: false,
	attached_projects: ["example-app"],
	project_settings: { "example-app": { voice: "Karen", retries: 2 } },
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

function renderEditor() {
	return renderWithProviders(
		<Routes>
			<Route path="/hook/:name" element={<HookEditor />} />
			<Route path="/hooks" element={<div>HOOKS-LIST</div>} />
		</Routes>,
		{ initialRoute: "/hook/notify-on-stop", client: makeQueryClient() },
	);
}

async function settingsBox() {
	return (await screen.findByLabelText("settings JSON")) as HTMLTextAreaElement;
}

describe("HookEditor — generic (non-lsp) settings editor", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("renders the hook's settings as editable JSON (not the lsp language table)", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor();

		const box = await settingsBox();
		expect(box.readOnly).toBe(false);
		expect(JSON.parse(box.value)).toEqual({ voice: "Daniel", retries: 2 });
		// A user hook never gets the built-in lsp table or the read-only note.
		expect(screen.queryByRole("table", { name: "lsp-report languages" })).toBeNull();
		expect(screen.getByRole("button", { name: "Save settings" })).toBeInTheDocument();
	});

	it("surfaces a JSON parse error and fires no IPC", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor();

		const box = await settingsBox();
		fireEvent.change(box, { target: { value: "{ voice: " } });
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

		// The parse failure is reported inline on the field (role="alert").
		expect(await screen.findByRole("alert")).toHaveTextContent(/SyntaxError|JSON/i);
		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"hook_set_settings",
			expect.anything(),
		);
		// The user's text is preserved for correction (not reverted).
		expect((screen.getByLabelText("settings JSON") as HTMLTextAreaElement).value).toBe(
			"{ voice: ",
		);
	});

	it("rejects a non-object payload (array / scalar) without firing IPC", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor();

		const box = await settingsBox();
		fireEvent.change(box, { target: { value: "[1, 2]" } });
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
		expect(
			await screen.findByText("Settings must be a JSON object"),
		).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("settings JSON"), {
			target: { value: '"just a string"' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
		expect(
			await screen.findByText("Settings must be a JSON object"),
		).toBeInTheDocument();

		expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
			"hook_set_settings",
			expect.anything(),
		);
	});

	it("a valid object saves at global scope with the parsed payload", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_show: () => USER_HOOK,
			hook_set_settings: (args) => {
				calls.push(args);
				return { success: true, output: "ok" };
			},
		});
		renderEditor();

		fireEvent.change(await settingsBox(), {
			target: { value: '{"voice": "Karen", "retries": 5}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toEqual({
			name: "notify-on-stop",
			global: true,
			project: null,
			settings: { voice: "Karen", retries: 5 },
		});
	});

	it("switching scope re-syncs the textarea to that scope's effective settings", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor();

		const box = await settingsBox();
		// Leave a stale edit in the box, then switch scope.
		fireEvent.change(box, { target: { value: '{"voice": "STALE"}' } });
		fireEvent.change(screen.getByLabelText("settings scope"), {
			target: { value: "example-app" },
		});

		await waitFor(() => {
			const next = screen.getByLabelText("settings JSON") as HTMLTextAreaElement;
			expect(JSON.parse(next.value)).toEqual({ voice: "Karen", retries: 2 });
		});
	});

	it("a scope switch clears a stale parse error", async () => {
		mockEditor({ hook_show: () => USER_HOOK });
		renderEditor();

		fireEvent.change(await settingsBox(), { target: { value: "nope" } });
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
		await screen.findByRole("alert");

		fireEvent.change(screen.getByLabelText("settings scope"), {
			target: { value: "example-app" },
		});
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("a failed generic settings save surfaces an error toast", async () => {
		mockEditor({
			hook_show: () => USER_HOOK,
			hook_set_settings: () => ({ success: false, output: "project not found" }),
		});
		renderEditor();

		fireEvent.change(await settingsBox(), { target: { value: '{"voice": "Karen"}' } });
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

		await waitFor(() =>
			expect(
				useAppStore
					.getState()
					.toasts.some(
						(t) => t.kind === "error" && t.title === "Couldn't save settings",
					),
			).toBe(true),
		);
	});
});
