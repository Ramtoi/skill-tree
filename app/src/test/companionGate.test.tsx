import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import {
	equipWithGate,
	equipErrorToast,
	CompanionProvisionError,
	useGateStoreForTests,
	CompanionGateProvider,
} from "@/hooks/useCompanionGate";
import { useSkillProjectEquip } from "@/hooks/useEquip";
import type { NeedsCompanions } from "@/lib/companions";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import type { EquipTarget } from "@/components/EquipPicker";
import type { Registry } from "@/types";
import { qk } from "@/lib/queryKeys";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";

/** Minimal I2 payload — one agent, one hook, one rule, all `will_write` on a
 *  single harness. Wave B's own fixture (per wave 1's follow-up note): the
 *  gate/dialog plumbing must not depend on the mock registry producing a
 *  particular harness mix. */
const PAYLOAD: NeedsCompanions = {
	skill: "orchestrate-advanced",
	project: "moon-base",
	items: [
		{
			kind: "agent",
			name: "orch-implementer",
			harness: "claude-code",
			target: "~/.claude/agents/orch-implementer.md",
			verdict: "will_write",
			scope: "user",
		},
		{
			kind: "hook",
			name: "orch-scope-guard",
			harness: "claude-code",
			target: "<repo>/.claude/settings.local.json",
			verdict: "will_write",
			activation: "while-running",
		},
		{
			kind: "permission",
			name: "Bash(git push --force:*)",
			harness: "claude-code",
			target: "<repo>/.claude/settings.json",
			verdict: "will_write",
			rule_kind: "deny",
		},
	],
};

function argsOf(payload: unknown): string[] {
	return (payload as { args?: string[] } | undefined)?.args ?? [];
}

function mockGatedEnable() {
	vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
		if (cmd !== "hub_cmd") return { success: true, output: "" };
		const args = argsOf(payload);
		if (args[0] === "enable" && args.includes("--with-companions")) {
			return { success: true, output: "" };
		}
		if (args[0] === "enable") {
			return {
				success: false,
				output: JSON.stringify({ needs_provisioning: PAYLOAD }),
			};
		}
		return { success: true, output: "" };
	});
}

beforeEach(() => {
	// `useGateStore` is module-level (a real dialog's state), so a leftover
	// `open: true` from one test would otherwise leak straight into the next.
	useGateStoreForTests.setState({ open: false, payload: null, busy: false, settle: null });
});

describe("equipWithGate — the exit-2 companion gate", () => {
	it("opens the dialog on an exit-2 needs_provisioning payload, and confirm re-runs with --with-companions", async () => {
		mockGatedEnable();
		renderWithProviders(<CompanionGateProvider />);

		let settled = false;
		const equipPromise = equipWithGate("orchestrate-advanced", "moon-base").then(() => {
			settled = true;
		});

		await screen.findByRole("dialog");
		expect(
			screen.getByText("orchestrate-advanced is equipped on moon-base. It also ships:"),
		).toBeInTheDocument();
		expect(settled).toBe(false); // still waiting on the user's choice

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Equip with companions" }));
			await equipPromise;
		});

		expect(invoke).toHaveBeenCalledWith(
			"hub_cmd",
			expect.objectContaining({
				args: expect.arrayContaining([
					"enable",
					"orchestrate-advanced",
					"--project",
					"moon-base",
					"--with-companions",
				]),
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("a failed --with-companions call rejects as CompanionProvisionError — the equip landed, the toast must say so", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			const args = argsOf(payload);
			if (args[0] === "enable" && args.includes("--with-companions")) {
				return {
					success: false,
					output: "ValueError: harness 'pi' does not support sub-agent definitions\n",
				};
			}
			if (args[0] === "enable") {
				return { success: false, output: JSON.stringify({ needs_provisioning: PAYLOAD }) };
			}
			return { success: true, output: "" };
		});
		renderWithProviders(<CompanionGateProvider />);

		let caught: unknown;
		const equipPromise = equipWithGate("orchestrate-advanced", "moon-base").catch((e) => {
			caught = e;
		});
		await screen.findByRole("dialog");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Equip with companions" }));
			await equipPromise;
		});

		expect(caught).toBeInstanceOf(CompanionProvisionError);
		expect((caught as Error).message).toMatch(/harness 'pi' does not support/);
		const failure = equipErrorToast(caught);
		expect(failure.title).toBe("Equipped, but couldn't provision companions");
		expect(failure.body).toMatch(/Retry with Provision on the project loadout/);
		// A plain failure keeps the old headline — nothing landed there.
		expect(equipErrorToast(new Error("boom")).title).toBe("Couldn't equip skill");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("'Equip skill only' resolves with no second call", async () => {
		mockGatedEnable();
		renderWithProviders(<CompanionGateProvider />);

		const equipPromise = equipWithGate("orchestrate-advanced", "moon-base");
		await screen.findByRole("dialog");

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Equip skill only" }));
			await equipPromise; // resolves — an acknowledgement, never a rejection
		});

		const enableCalls = vi
			.mocked(invoke)
			.mock.calls.filter(([cmd, payload]) => cmd === "hub_cmd" && argsOf(payload)[0] === "enable");
		expect(enableCalls).toHaveLength(1); // only the ORIGINAL gating call
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("Esc resolves with no second call, same as 'Equip skill only'", async () => {
		mockGatedEnable();
		renderWithProviders(<CompanionGateProvider />);

		const equipPromise = equipWithGate("orchestrate-advanced", "moon-base");
		const dialog = await screen.findByRole("dialog");

		await act(async () => {
			fireEvent.keyDown(dialog, { key: "Escape" });
			await equipPromise;
		});

		const enableCalls = vi
			.mocked(invoke)
			.mock.calls.filter(([cmd, payload]) => cmd === "hub_cmd" && argsOf(payload)[0] === "enable");
		expect(enableCalls).toHaveLength(1);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("a non-zero run with no payload still rejects with the CLI's first error, and opens nothing", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			const args = argsOf(payload);
			if (args[0] === "enable") {
				return { success: false, output: "error: unknown skill boom\n" };
			}
			return { success: true, output: "" };
		});
		renderWithProviders(<CompanionGateProvider />);

		await expect(equipWithGate("boom", "moon-base")).rejects.toThrow(/boom/);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("opts.force skips the dialog entirely", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			const args = argsOf(payload);
			if (args[0] === "enable" && args.includes("--with-companions")) {
				return { success: true, output: "" };
			}
			return { success: false, output: "unexpected call" };
		});
		renderWithProviders(<CompanionGateProvider />);

		await equipWithGate("orchestrate-advanced", "moon-base", { force: "with" });

		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith(
			"hub_cmd",
			expect.objectContaining({
				args: expect.arrayContaining(["--with-companions"]),
			}),
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

describe("ProjectWorkspace disable undo — replays exactly what was removed (C8)", () => {
	function renderWorkspace() {
		useAppStore.setState({
			toasts: [],
			harnesses: [
				{
					id: "claude-code",
					label: "Claude Code",
					installed: true,
					on_globally: true,
					used_by_projects: [],
				},
			],
		});
		const client = makeQueryClient();
		primeRegistry(client, sampleRegistry);
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ client, initialRoute: "/project/example-app" },
		);
	}

	it("replays --with-companions when removed_companions was non-empty", async () => {
		// Delegate anything but the one `disable` call to the beforeEach-installed
		// default (setup.ts) — a blanket fallback would answer `read_registry`'s
		// background refetch with a bogus truthy object and clobber the primed
		// registry (react-query only KEEPS stale data on an errored/undefined
		// refetch; it happily overwrites it on a "successful" one).
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = argsOf(payload);
			if (cmd === "hub_cmd" && args[0] === "disable" && args[1] === "brainstorm") {
				return {
					success: true,
					output: JSON.stringify({
						removed_companions: {
							hooks: ["orch-scope-guard"],
							agents: ["orch-implementer"],
							permissions: [{ pattern: "Bash(git push --force:*)", kind: "deny" }],
						},
					}),
				};
			}
			if (cmd === "hub_cmd" && args[0] === "enable") return { success: true, output: "" };
			return prev ? prev(cmd as never, payload as never) : undefined;
		});
		renderWorkspace();

		fireEvent.click(await screen.findByRole("button", { name: "Unequip brainstorm" }));

		const toast = await waitFor(() => {
			const t = useAppStore
				.getState()
				.toasts.find((x) => x.title === "Unequipped brainstorm from example-app");
			expect(t).toBeDefined();
			return t!;
		});
		expect(toast.body).toMatch(/Removed/);

		toast.action!.onClick();

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: expect.arrayContaining([
						"enable",
						"brainstorm",
						"--project",
						"example-app",
						"--with-companions",
					]),
				}),
			),
		);
	});

	it("replays --skill-only when nothing was removed", async () => {
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = argsOf(payload);
			if (cmd === "hub_cmd" && args[0] === "disable" && args[1] === "brainstorm") {
				return {
					success: true,
					output: JSON.stringify({
						removed_companions: { hooks: [], agents: [], permissions: [] },
					}),
				};
			}
			if (cmd === "hub_cmd" && args[0] === "enable") return { success: true, output: "" };
			return prev ? prev(cmd as never, payload as never) : undefined;
		});
		renderWorkspace();

		fireEvent.click(await screen.findByRole("button", { name: "Unequip brainstorm" }));

		const toast = await waitFor(() => {
			const t = useAppStore
				.getState()
				.toasts.find((x) => x.title === "Unequipped brainstorm from example-app");
			expect(t).toBeDefined();
			return t!;
		});

		toast.action!.onClick();

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: expect.arrayContaining([
						"enable",
						"brainstorm",
						"--project",
						"example-app",
						"--skill-only",
					]),
				}),
			),
		);
		const withCompanionsCalls = vi.mocked(invoke).mock.calls.filter(([cmd, payload]) => {
			const args = argsOf(payload);
			return cmd === "hub_cmd" && args.includes("--with-companions");
		});
		expect(withCompanionsCalls).toHaveLength(0);
	});
});

// Review S-3: `useSkillProjectEquip`'s unequip (the connections-panel toggle,
// same hook `SkillLibrary`'s row equip uses) must acknowledge what a
// companion-shipping skill's removal actually deleted — the SAME
// `removalSentence` `ProjectWorkspace.disableSkill` already surfaces — not
// silently delete user-scope agent files with only a bare "Unequipped" title.
function equipHookWrapper({ children }: { children: React.ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSkillProjectEquip equip — a landed equip whose companions failed (review R3/R4)", () => {
	const TARGET: EquipTarget = { id: "example-app", name: "example-app", state: "off" };

	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		queryClient.clear();
		primeRegistry(queryClient, sampleRegistry);
		useGateStoreForTests.setState({ open: false, payload: null, busy: false, settle: null });
	});

	it("keeps the optimistic equip and toasts the provisioning headline", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			const args = argsOf(payload);
			if (args[0] === "enable" && args.includes("--with-companions")) {
				return {
					success: false,
					output: "ValueError: harness 'pi' does not support sub-agent definitions\n",
				};
			}
			if (args[0] === "enable") {
				return { success: false, output: JSON.stringify({ needs_provisioning: PAYLOAD }) };
			}
			return { success: true, output: "" };
		});

		const { result } = renderHook(() => useSkillProjectEquip("orchestrate-advanced"), {
			wrapper: equipHookWrapper,
		});
		let caught: unknown;
		let pending!: Promise<void>;
		act(() => {
			pending = result.current(TARGET, "on").catch((e) => {
				caught = e;
			});
		});
		// No dialog is mounted here — answer the gate through its store, the
		// way the dialog's own confirm button does.
		await waitFor(() => expect(useGateStoreForTests.getState().settle).not.toBeNull());
		await act(async () => {
			useGateStoreForTests.getState().settle?.(true);
			await pending;
		});

		expect(caught).toBeInstanceOf(CompanionProvisionError);
		const reg = queryClient.getQueryData<Registry>(qk.registry());
		expect(reg?.projects["example-app"]?.enabled).toContain("orchestrate-advanced");
		const toast = useAppStore
			.getState()
			.toasts.find((t) => t.title === "Equipped, but couldn't provision companions");
		expect(toast).toBeDefined();
		expect(toast!.body).toMatch(/harness 'pi'/);
		expect(toast!.body).toMatch(/Retry with Provision on the project loadout/);
		expect(toast!.body).not.toMatch(/\.\./);
	});

	it("a plain equip failure still rolls the optimistic equip back", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			const args = argsOf(payload);
			if (args[0] === "enable") return { success: false, output: "error: unknown skill boom\n" };
			return { success: true, output: "" };
		});
		const { result } = renderHook(() => useSkillProjectEquip("orchestrate-advanced"), {
			wrapper: equipHookWrapper,
		});
		await act(async () => {
			await result.current(TARGET, "on").catch(() => undefined);
		});
		const reg = queryClient.getQueryData<Registry>(qk.registry());
		expect(reg?.projects["example-app"]?.enabled ?? []).not.toContain("orchestrate-advanced");
		expect(useAppStore.getState().toasts.some((t) => t.title === "Couldn't equip skill")).toBe(true);
	});
});

describe("useSkillProjectEquip unequip — shows the removal sentence (S-3)", () => {
	const TARGET: EquipTarget = { id: "example-app", name: "example-app", state: "on" };

	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		queryClient.clear();
		primeRegistry(queryClient, sampleRegistry);
	});

	it("puts removalSentence(payload) in the toast body when companions were removed", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			const args = argsOf(payload);
			if (args[0] === "disable" && args[1] === "brainstorm") {
				return {
					success: true,
					output: JSON.stringify({
						removed_companions: { hooks: ["orch-scope-guard"], agents: [], permissions: [] },
					}),
				};
			}
			return { success: true, output: "" };
		});

		const { result } = renderHook(() => useSkillProjectEquip("brainstorm"), {
			wrapper: equipHookWrapper,
		});
		await act(async () => {
			await result.current(TARGET, "off");
		});

		expect(invoke).toHaveBeenCalledWith(
			"hub_cmd",
			expect.objectContaining({
				args: ["disable", "brainstorm", "--project", "example-app", "--json"],
			}),
		);
		const toast = useAppStore
			.getState()
			.toasts.find((t) => t.title === "Unequipped brainstorm from example-app");
		expect(toast).toBeDefined();
		expect(toast!.body).toBe("Removed 1 hook");
	});

	it("leaves the toast body empty when nothing was removed", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd !== "hub_cmd") return { success: true, output: "" };
			return { success: true, output: "" };
		});

		const { result } = renderHook(() => useSkillProjectEquip("brainstorm"), {
			wrapper: equipHookWrapper,
		});
		await act(async () => {
			await result.current(TARGET, "off");
		});

		const toast = useAppStore
			.getState()
			.toasts.find((t) => t.title === "Unequipped brainstorm from example-app");
		expect(toast).toBeDefined();
		expect(toast!.body).toBeUndefined();
	});
});
