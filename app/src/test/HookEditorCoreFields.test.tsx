import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { queryClient } from "@/lib/queryClient";
import { useAppStore } from "@/store";

// The raw matcher is the documented power-user override that bypasses per-harness
// tool translation, so a marshalling regression changes WHICH tool invocations
// fire the hook — a silent behavioural change inside the user's harness. Clearing
// a timeout was already a shipped review-panel bug (fixed by the Option<String>
// encoding in commands/hooks.rs); nothing pinned the fix from the frontend, and
// every existing hook fixture sets `matcher: ""` so the matcher path never ran.

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

const BASE_HOOK = {
	name: "notify-on-stop",
	provenance: "user",
	event: "Stop",
	command: "say done",
	description: "",
	tools: ["Edit"],
	matcher: "",
	timeout: null as number | null,
	harnesses: null,
	settings: {},
	attached_global: false,
	attached_projects: [] as string[],
	project_settings: {},
	reach: {},
};

function mockEditor(
	hook: Record<string, unknown>,
	calls: unknown[],
	result: { success: boolean; output: string } = { success: true, output: "ok" },
) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		if (cmd === "hook_capabilities") return Promise.resolve(CAPS);
		if (cmd === "hook_show") return Promise.resolve(hook);
		if (cmd === "hook_edit") {
			calls.push(args);
			return Promise.resolve(result);
		}
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderEditor() {
	return renderWithProviders(
		<Routes>
			<Route path="/hook/:name" element={<HookEditor />} />
		</Routes>,
		{ initialRoute: "/hook/notify-on-stop", client: makeQueryClient() },
	);
}

describe("HookEditor — raw matcher round-trip", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("switching to Raw matcher mode sends the matcher verbatim and CLEARS the tools", async () => {
		const calls: unknown[] = [];
		mockEditor(BASE_HOOK, calls);
		renderEditor();

		// The hook has tools → it opens in Specific-tools mode; the matcher field
		// only exists once the user picks the escape hatch (D2: the mode IS the
		// precedence now, so the two can never be armed at once).
		// Wait for hydration before asserting the derived mode, then switch.
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Specific tools" })).toBeChecked(),
		);
		expect(screen.queryByLabelText("raw matcher")).toBeNull();
		fireEvent.click(screen.getByRole("radio", { name: "Raw matcher" }));

		const matcherInput = screen.getByLabelText("raw matcher") as HTMLInputElement;
		fireEvent.change(matcherInput, { target: { value: "Notebook.*" } });

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({
			name: "notify-on-stop",
			matcher: "Notebook.*",
			// The tools are CLEARED: keeping them would persist a tool list the
			// harness never consults (the matcher wins), which is exactly the
			// two-sources-of-truth confusion the segmented mode removes.
			tools: [],
		});
	});

	it("a legacy hook carrying BOTH opens in Raw matcher mode and says the tools are ignored", async () => {
		const calls: unknown[] = [];
		mockEditor({ ...BASE_HOOK, matcher: "Notebook.*", tools: ["Edit"] }, calls);
		renderEditor();

		await screen.findByLabelText("command");
		// The matcher is what actually fires the hook, so that is the mode we open
		// in — showing the tool picker would misdescribe when it runs. (The mode is
		// set by the hydration effect, so wait for it rather than read frame one.)
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Raw matcher" })).toBeChecked(),
		);
		expect(
			(screen.getByLabelText("raw matcher") as HTMLInputElement).value,
		).toBe("Notebook.*");
		expect(
			screen.getByText(/is ignored while a matcher is set/),
		).toBeInTheDocument();
	});

	it("switching from Raw matcher to All tools sends an empty matcher (a clear, not 'untouched')", async () => {
		const calls: unknown[] = [];
		mockEditor({ ...BASE_HOOK, matcher: "Notebook.*", tools: [] }, calls);
		renderEditor();

		await screen.findByLabelText("command");
		await waitFor(() =>
			expect(
				(screen.getByLabelText("raw matcher") as HTMLInputElement).value,
			).toBe("Notebook.*"),
		);
		fireEvent.click(screen.getByRole("radio", { name: "All tools" }));

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(calls.length).toBe(1));
		// `null` here would collapse into "field not touched" on the Rust side and
		// the hook would keep firing on the old regex while the UI says "all tools".
		expect((calls[0] as { matcher: unknown }).matcher).toBe("");
		expect((calls[0] as { tools: unknown }).tools).toEqual([]);
	});
});

describe("HookEditor — timeout round-trip", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("setting a timeout sends it as a string the bridge can forward", async () => {
		const calls: unknown[] = [];
		mockEditor(BASE_HOOK, calls);
		renderEditor();

		await screen.findByLabelText("command");
		// ADVANCED is closed by default — open it to reach the timeout field.
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		fireEvent.change(screen.getByLabelText("timeout"), {
			target: { value: "45" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(calls.length).toBe(1));
		// useHookEdit stringifies so the Rust side can tell "set to 45" from
		// "clear" from "not touched" (Option<String>).
		expect((calls[0] as { timeout: unknown }).timeout).toBe("45");
	});

	it("clearing a timeout sends the empty-string clear sentinel, not null", async () => {
		const calls: unknown[] = [];
		mockEditor({ ...BASE_HOOK, timeout: 30 }, calls);
		renderEditor();

		await screen.findByLabelText("command");
		// ADVANCED is closed by default — open it to reach the timeout field.
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		const timeoutInput = screen.getByLabelText("timeout") as HTMLInputElement;
		expect(timeoutInput.value).toBe("30");
		fireEvent.change(timeoutInput, { target: { value: "" } });

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(calls.length).toBe(1));
		// `null` here would collapse into "field not touched" on the Rust side and
		// the clear would silently be a no-op (the shipped review-panel bug).
		expect((calls[0] as { timeout: unknown }).timeout).toBe("");
	});
});

// ─── Unsaved-edit durability across a sibling refetch ────────────────────────
// Every hook mutation invalidates the WHOLE ["hooks"] key (useHooks.invalidateHooks).
// "Save settings" in the side panel is therefore enough to refetch `hook_show`
// with changed contents while the user is mid-edit in the command textarea.
// Hydration keyed on the react-query object (rather than the hook's identity)
// used to overwrite those edits and clear the UNSAVED pill with no warning —
// silent data loss. These use the app-singleton queryClient (the one
// `invalidateHooks` actually targets) so the refetch is the real one.

const OTHER_HOOK = {
	...BASE_HOOK,
	name: "other-hook",
	event: "PreToolUse",
	command: "echo other",
	tools: [] as string[],
};

function NavTo({ to, label }: { to: string; label: string }) {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate(to)}>
			{label}
		</button>
	);
}

describe("HookEditor — unsaved core-field edits survive a sibling refetch", () => {
	// `current` is what `hook_show` answers; tests swap it to simulate the
	// definition changing underneath the open editor.
	let current: Record<string, unknown>;
	let settingsCalls: unknown[];

	beforeEach(() => {
		queryClient.clear();
		useAppStore.setState({ toasts: [] });
		current = { ...BASE_HOOK };
		settingsCalls = [];
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
			if (cmd === "hook_capabilities") return Promise.resolve(CAPS);
			if (cmd === "hook_show") {
				const name = (args as { name?: string } | undefined)?.name;
				return Promise.resolve(
					name === OTHER_HOOK.name ? { ...OTHER_HOOK } : { ...current },
				);
			}
			if (cmd === "hook_set_settings") {
				settingsCalls.push(args);
				return Promise.resolve({ success: true, output: "ok" });
			}
			return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
		}) as never);
	});

	function render(extra?: ReactNode) {
		return renderWithProviders(
			<>
				{extra}
				<Routes>
					<Route path="/hook/:name" element={<HookEditor />} />
				</Routes>
			</>,
			{ initialRoute: "/hook/notify-on-stop", client: queryClient },
		);
	}

	it("keeps the typed command (and the UNSAVED pill) when saving settings refetches changed data", async () => {
		render();

		const commandInput = (await screen.findByLabelText(
			"command",
		)) as HTMLTextAreaElement;
		expect(commandInput.value).toBe("say done");

		fireEvent.change(commandInput, { target: { value: "say EDITED" } });
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();

		// The definition changes server-side (the settings write lands), so the
		// refetch below returns a genuinely different object — react-query's
		// structural sharing does NOT shield us from it.
		current = { ...BASE_HOOK, settings: { languages: { python: {} } } };

		fireEvent.change(screen.getByLabelText("settings JSON"), {
			target: { value: '{"languages":{"python":{}}}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
		await waitFor(() => expect(settingsCalls.length).toBe(1));
		// Let the invalidation-driven `hook_show` refetch land.
		await waitFor(() =>
			expect(
				(queryClient.getQueryData(["hooks", "show", "notify-on-stop"]) as
					| { settings?: unknown }
					| undefined)?.settings,
			).toEqual({ languages: { python: {} } }),
		);

		// The whole point: the user's in-progress edit is still there, and the
		// editor still tells them it is unsaved.
		expect(
			(screen.getByLabelText("command") as HTMLTextAreaElement).value,
		).toBe("say EDITED");
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
	});

	it("still hydrates when the route moves to a DIFFERENT hook, even from a dirty form", async () => {
		render(<NavTo to="/hook/other-hook" label="go other" />);

		const commandInput = (await screen.findByLabelText(
			"command",
		)) as HTMLTextAreaElement;
		fireEvent.change(commandInput, { target: { value: "say EDITED" } });
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "go other" }));

		// A new hook identity always re-hydrates — otherwise a dirty form would
		// poison whatever hook the user opens next.
		await waitFor(() =>
			expect(
				(screen.getByLabelText("command") as HTMLTextAreaElement).value,
			).toBe("echo other"),
		);
		expect(screen.getByLabelText("event")).toHaveTextContent("PreToolUse");
		expect(screen.queryByText("UNSAVED")).toBeNull();
	});
});
