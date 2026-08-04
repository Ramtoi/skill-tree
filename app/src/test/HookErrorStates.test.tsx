import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HooksScreen } from "@/screens/HooksScreen";
import { HookEditor } from "@/screens/HookEditor";

// Failure + not-yet-probed states of the two hook screens. `hook_list`/`hook_show`
// reject on ANY hub.py failure (missing Python, corrupt registry, a bad hook name
// typed into the URL) and a broken error branch means a blank screen with no way
// out. The null capability cache is not an edge case at all — it is the default
// fresh-install state (hook_capabilities returns Null until the first sync), so
// "reach unknown" is what every brand-new user sees on every row.

const HOOK_ROW = {
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
};

/** Answer specific commands; `reject` names commands that should REJECT. */
function mockHooks(
	over: Record<string, (args?: unknown) => unknown> = {},
	reject: Record<string, string> = {},
) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (reject[cmd]) return Promise.reject(new Error(reject[cmd]));
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		if (over[cmd]) return Promise.resolve(over[cmd](args));
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

describe("HooksScreen — failure state", () => {
	it("renders a recoverable error state (not a blank screen) when hook_list rejects", async () => {
		mockHooks({}, { hook_list: "hub.py exited 1: registry.yaml is corrupt" });
		renderWithProviders(
			<Routes>
				<Route path="/hooks" element={<HooksScreen />} />
			</Routes>,
			{ initialRoute: "/hooks", client: makeQueryClient() },
		);

		expect(await screen.findByText("Could not load hooks")).toBeInTheDocument();
		// The underlying reason is shown, not swallowed.
		expect(screen.getByText(/registry.yaml is corrupt/)).toBeInTheDocument();
		// No misleading "No hooks yet" empty state on a failed load.
		expect(screen.queryByText("No hooks yet")).toBeNull();
	});
});

describe("HookEditor — failure state", () => {
	it("renders 'Hook not found' with a working escape route when hook_show rejects", async () => {
		mockHooks({}, { hook_show: "no hook named ghost-hook" });
		renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
				<Route path="/hooks" element={<div>HOOKS-LIST</div>} />
			</Routes>,
			{ initialRoute: "/hook/ghost-hook", client: makeQueryClient() },
		);

		expect(await screen.findByText("Hook not found")).toBeInTheDocument();
		expect(screen.getByText(/ghost-hook/)).toBeInTheDocument();
		// The dead end has an exit.
		fireEvent.click(screen.getByRole("button", { name: "Back to hooks" }));
		await waitFor(() =>
			expect(screen.getByText("HOOKS-LIST")).toBeInTheDocument(),
		);
	});
});

describe("HookReachBadges — never-probed cache", () => {
	it("says 'reach unknown' (with the how-to-fix tooltip) instead of implying zero reach", async () => {
		// hook_capabilities → null is the honest fresh-install default (no sync yet).
		mockHooks({
			hook_list: () => ({ hooks: [HOOK_ROW], reach: {} }),
			hook_capabilities: () => null,
		});
		renderWithProviders(
			<Routes>
				<Route path="/hooks" element={<HooksScreen />} />
			</Routes>,
			{ initialRoute: "/hooks", client: makeQueryClient() },
		);

		const unknown = await screen.findByText("reach unknown");
		expect(unknown).toBeInTheDocument();
		expect(unknown).toHaveAttribute(
			"title",
			"Run `hub sync` to probe hook capability per harness.",
		);
		// Nothing claims a harness supports (or doesn't support) the hook.
		expect(screen.queryByLabelText(/: supported$/)).toBeNull();
		expect(screen.queryByLabelText(/: unsupported$/)).toBeNull();
	});

	it("the editor's per-event reach also degrades to 'reach unknown'", async () => {
		mockHooks({
			hook_show: () => ({ ...HOOK_ROW, project_settings: {}, reach: {} }),
			hook_capabilities: () => null,
		});
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
			</Routes>,
			{ initialRoute: "/hook/notify-on-stop", client: makeQueryClient() },
		);

		await screen.findByLabelText("command");
		const reach = container.querySelector(".hook-event-reach");
		expect(reach).not.toBeNull();
		expect(reach).toHaveTextContent("reach unknown");
	});
});
