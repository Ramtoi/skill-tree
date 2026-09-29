import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { NavPanel } from "@/components/NavPanel";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { qk } from "@/lib/queryKeys";
import { readBackTarget } from "@/lib/backTarget";
import { Processes } from "@/store/processes";
import type { Registry } from "@/types";
import {
	renderWithProviders,
	primeRegistry,
	makeQueryClient,
	sampleRegistry,
} from "./helpers";

/** Renders the current location's pathname — used to prove a navigation
 *  actually happened, the same pattern `backNavigation.test.tsx` uses. */
function LocationProbe() {
	const loc = useLocation();
	return (
		<div data-testid="loc" data-from={readBackTarget(loc.state)?.path}>
			{loc.pathname}
		</div>
	);
}

/**
 * Capture every `hub_cmd` argv. `read_registry` answers from the SAME
 * QueryClient the component reads — the write path here is optimistic
 * (`setQueryData` before the network call resolves), so a background
 * refetch triggered by `invalidateRegistry()` must read that same key back
 * rather than resolve to `undefined` (react-query treats an `undefined`
 * queryFn result as an error and drops the query's data on a background
 * refetch failure — the exact clobber this avoids). `read_search_corpus`
 * gets a benign empty corpus for the same reason.
 */
/**
 * Lets a test hold one `read_registry` reply open past the moment it was
 * invoked — reproducing the live-app race this regression test pins: a
 * registry refetch dispatched BEFORE a bundle-membership optimistic write
 * resolves a few ticks AFTER it, with a snapshot captured at CALL time
 * (before the write). `allowNext()` lets one call through immediately;
 * `armHold()` then captures every later call's snapshot and blocks its
 * resolution until `release()`, after which every call passes straight
 * through again.
 */
function makeRegistryReadGate() {
	let allowImmediate = 0;
	let release: (() => void) | null = null;
	let pending: Promise<void> | null = null;
	// Resolves once the currently-held call's `waitIfHeld()` has returned —
	// i.e. the mock is about to hand the stale snapshot back to its caller.
	// The test awaits this (inside `act`) so it never inspects the DOM in the
	// short in-between window before the stale reply has even been issued.
	let settledResolve: (() => void) | null = null;
	let settled: Promise<void> = Promise.resolve();
	return {
		allowNext() {
			allowImmediate += 1;
		},
		armHold() {
			pending = new Promise<void>((r) => {
				release = r;
			});
			settled = new Promise<void>((r) => {
				settledResolve = r;
			});
		},
		release() {
			release?.();
		},
		get settled(): Promise<void> {
			return settled;
		},
		async waitIfHeld(): Promise<void> {
			if (allowImmediate > 0) {
				allowImmediate -= 1;
				return;
			}
			if (pending) {
				await pending;
				settledResolve?.();
			}
		},
	};
}

function mockHub(
	client: ReturnType<typeof makeQueryClient>,
	override?: (a: string[]) => { success: boolean; output: string } | Promise<{ success: boolean; output: string }> | undefined,
	registryReadGate?: ReturnType<typeof makeRegistryReadGate>,
) {
	const calls: string[][] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "hub_cmd") {
			const a = (args as { args: string[] }).args;
			calls.push(a);
			const result = await (override?.(a) ?? { success: true, output: "" });
			if (result.success && a[0] === "new" && (a[1] === "skill" || a[1] === "mcp")) {
				const name = a[2];
				const registry = client.getQueryData<Registry>(qk.registry());
				if (registry) {
					const valueAfter = (flag: string) => a[a.indexOf(flag) + 1];
					client.setQueryData<Registry>(qk.registry(), {
						...registry,
						skills: {
							...registry.skills,
							[name]: {
								version: "1.0.0",
								description: valueAfter("--description"),
								source: `~/h/skills/${name}`,
								type: valueAfter("--type") as "claude-skill" | "mcp-server",
								scope: valueAfter("--scope") as "global" | "portable" | "project-specific",
								upstream: null,
								managed: "local",
							},
						},
					});
				}
			}
			return Promise.resolve(result);
		}
		if (cmd === "mcp_add_json") {
			const { args: a, body } = args as { args: string[]; body: string };
			calls.push(a);
			const result = await (override?.(a) ?? { success: true, output: "" });
			if (!result.success) {
				return Promise.resolve({ ok: false, error: result.output || "failed", code: "other" });
			}
			const name = a[2];
			let spec: Record<string, unknown> = {};
			try {
				spec = JSON.parse(body) as Record<string, unknown>;
			} catch {
				/* not needed for these tests */
			}
			const registry = client.getQueryData<Registry>(qk.registry());
			if (registry) {
				client.setQueryData<Registry>(qk.registry(), {
					...registry,
					skills: {
						...registry.skills,
						[name]: {
							version: "1.0.0",
							description: "",
							source: `~/h/mcp/${name}`,
							type: "mcp-server",
							scope: "global",
							upstream: null,
							managed: "local",
						},
					},
				});
			}
			return Promise.resolve({
				ok: true,
				name,
				created_dir: "",
				registered: true,
				equipped: null,
				spec,
				warnings: [],
				probe: null,
			});
		}
		if (cmd === "read_registry") {
			// The snapshot is captured NOW, at invocation — same as the real
			// backend reading the on-disk registry at the moment it was asked,
			// before any later in-memory optimistic write.
			const snapshot = client.getQueryData(qk.registry());
			if (registryReadGate) await registryReadGate.waitIfHeld();
			return Promise.resolve(snapshot);
		}
		if (cmd === "read_search_corpus") {
			return Promise.resolve({ skills: {}, snippets: {} });
		}
		// SkillLibrary mounts `useLocalCandidates`/`useSnippetNames` unconditionally;
		// both fetch on first mount regardless of their own `staleTime`, so both
		// invoke commands need a real (non-undefined) reply here too.
		if (cmd === "local_skill_candidates" || cmd === "snippets_list") {
			return Promise.resolve([]);
		}
		return Promise.resolve(undefined);
	}) as never);
	return calls;
}

function renderBundle(
	registry: Registry,
	name: string,
	override?: (a: string[]) => { success: boolean; output: string } | Promise<{ success: boolean; output: string }> | undefined,
) {
	const client = makeQueryClient();
	primeRegistry(client, registry);
	const calls = mockHub(client, override);
	renderWithProviders(
		<>
			<Routes>
				<Route path="/bundle/:name" element={<SkillLibrary />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: `/bundle/${name}` },
	);
	return { client, calls };
}

/** Same as `renderBundle`, plus a wildcard route rendering `LocationProbe` —
 *  for a test that must prove a navigation actually LANDED somewhere else,
 *  not just that a handler fired. */
function renderBundleWithProbe(
	registry: Registry,
	name: string,
	override?: (a: string[]) => { success: boolean; output: string } | Promise<{ success: boolean; output: string }> | undefined,
) {
	const client = makeQueryClient();
	primeRegistry(client, registry);
	const calls = mockHub(client, override);
	renderWithProviders(
		<>
			<Routes>
				<Route path="/bundle/:name" element={<SkillLibrary />} />
				<Route path="*" element={<LocationProbe />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: `/bundle/${name}` },
	);
	return { client, calls };
}

function findBundleUpdateCall(calls: string[][], bundleName: string) {
	return calls.filter(
		(a) => a[0] === "bundle" && a[1] === "update" && a[2] === bundleName,
	);
}

function skillsArg(argv: string[]): string {
	const i = argv.indexOf("--skills");
	return i >= 0 ? argv[i + 1] : "";
}

beforeEach(() => {
	useAppStore.setState({ toasts: [] });
	for (const p of Processes.list()) Processes.dismiss(p.id);
});

describe("Library bundle mode — case 1: band + membership pool", () => {
	it("renders the band and lists only members present in the registry", async () => {
		renderBundle(sampleRegistry, "android");

		expect(await screen.findByTestId("library-bundle-band")).toBeInTheDocument();
		expect(screen.getByText("rt-android-expert")).toBeInTheDocument();
		expect(screen.getByText("android-compose-ui")).toBeInTheDocument();
		expect(screen.queryByText("brainstorm")).toBeNull();
		expect(screen.queryByText("fs-mcp")).toBeNull();
	});
});

describe("Library bundle mode — case 2: description input", () => {
	it("commits on blur only when the value changed, and reverts on Escape", async () => {
		const { calls } = renderBundle(sampleRegistry, "android");
		const input = await screen.findByLabelText("Bundle description");
		expect(input).toHaveValue("Android workflows");

		// Unchanged click-in/click-out: no write.
		fireEvent.focus(input);
		fireEvent.blur(input);
		await Promise.resolve();
		expect(findBundleUpdateCall(calls, "android")).toHaveLength(0);

		// A real edit commits on blur, as one merged `--description=` token.
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "New copy" } });
		fireEvent.blur(input);
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);
		const argv = findBundleUpdateCall(calls, "android")[0];
		expect(argv).toContain("--description=New copy");
		expect(argv).toContain("--json");

		// Escape reverts the draft to the (now-current) SAVED value and never
		// commits it — "New copy" is the current saved value after the write
		// above landed and its optimistic cache update settled.
		//
		// A REAL focus (`userEvent.click`, not `fireEvent.focus`) is required
		// here: jsdom's `.blur()` is a no-op on an element that isn't actually
		// `document.activeElement`, so `fireEvent.focus` would let this
		// assertion pass even if the component never called `.blur()` at all
		// — the exact false-positive finding #7 flags. Asserting the blur
		// itself landed (`document.activeElement` moved away) is what makes
		// this test able to fail for the reason it exists: deleting the
		// `skipNextCommitRef` guard would re-commit "Thrown away" here.
		await userEvent.click(input);
		await userEvent.clear(input);
		await userEvent.type(input, "Thrown away");
		await userEvent.keyboard("{Escape}");
		expect(input).toHaveValue("New copy");
		expect(document.activeElement).not.toBe(input);
		expect(findBundleUpdateCall(calls, "android")).toHaveLength(1);
	});

	it("never replaces a typed value with a registry refetch while focused", async () => {
		const { client } = renderBundle(sampleRegistry, "android");
		const input = await screen.findByLabelText("Bundle description");

		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "still typing" } });

		// A registry refetch lands mid-type (e.g. an unrelated sync). `act`
		// flushes the re-render, so the check below sees its result.
		const prev = client.getQueryData<Registry>(qk.registry())!;
		await act(async () => {
			client.setQueryData<Registry>(qk.registry(), {
				...prev,
				bundles: {
					...prev.bundles,
					android: { ...prev.bundles.android, description: "Landed elsewhere" },
				},
			});
		});

		expect(input).toHaveValue("still typing");
	});

	// library-bundle-mode.journey.spec.ts "bundle description: click-in/
	// click-out writes nothing; Enter commits and survives a refetch"
	// (~:114) — the tests above exercise `commitIfDirty()` through a plain
	// `fireEvent.blur`, never through the input's own `onKeyDown` Enter
	// handler (`(e.target as HTMLInputElement).blur()`), so that handler
	// itself has no test. This also covers the "survives a refetch" half:
	// the journey's own comment explains WHY — the input hydrates from the
	// registry only while unfocused and clean. So once Enter has blurred and
	// committed, the write's own refetch must leave the committed value in
	// place, and a later refetch carrying a DIFFERENT value (another writer)
	// must re-hydrate the input. A commit that left the input dirty would
	// keep showing its own draft and miss that second refetch.
	it("commits via Enter (not just blur) and the committed value survives a background refetch", async () => {
		const { calls, client } = renderBundle(sampleRegistry, "android");
		const input = await screen.findByLabelText("Bundle description");
		expect(input).toHaveValue("Android workflows");

		await userEvent.click(input);
		await userEvent.clear(input);
		await userEvent.type(input, "Android workflows, retitled");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);
		expect(findBundleUpdateCall(calls, "android")[0]).toContain(
			"--description=Android workflows, retitled",
		);
		expect(document.activeElement).not.toBe(input);
		expect(input).toHaveValue("Android workflows, retitled");

		// The write's own `invalidateRegistry()` refetch settles: the committed
		// value is still what the input shows.
		await waitFor(() => expect(client.isFetching()).toBe(0));
		expect(input).toHaveValue("Android workflows, retitled");

		// A later background refetch carries a different value. Unfocused and
		// clean, the input re-hydrates from it.
		const prev = client.getQueryData<Registry>(qk.registry())!;
		expect(prev.bundles.android.description).toBe("Android workflows, retitled");
		act(() => {
			client.setQueryData<Registry>(qk.registry(), {
				...prev,
				bundles: {
					...prev.bundles,
					android: { ...prev.bundles.android, description: "Edited on another machine" },
				},
			});
		});
		await waitFor(() => expect(input).toHaveValue("Edited on another machine"));
	});
});

describe("Library bundle mode — case 3: icon", () => {
	it("writes the picked icon as one merged token", async () => {
		const { calls } = renderBundle(sampleRegistry, "android");

		fireEvent.click(await screen.findByRole("button", { name: "Change icon" }));
		fireEvent.click(await screen.findByRole("button", { name: "Use 🔧" }));

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);
		const argv = findBundleUpdateCall(calls, "android")[0];
		expect(argv).toContain("--icon=🔧");
	});

	// Finding #1: the overflow's "Change icon…" used to reuse the overflow
	// TRIGGER's own click handler (toggling the already-closed overflow menu
	// a second time) instead of opening the icon popover — a dead menu item,
	// and the ONLY icon path once the header shows an in-place back arrow
	// instead of the identity glyph.
	it("opens the icon picker from the overflow menu, not just the glyph", async () => {
		renderBundle(sampleRegistry, "android");

		fireEvent.click(screen.getByTestId("overflow-trigger"));
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Change icon…" }),
		);

		expect(
			await screen.findByRole("dialog", { name: "Change android's icon" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Use 🔧" })).toBeInTheDocument();
	});
});

describe("Library bundle mode — case 4: row remove + undo", () => {
	it("removes via the row action and undoes back to the original csv", async () => {
		const { calls } = renderBundle(sampleRegistry, "android");

		fireEvent.click(
			await screen.findByLabelText("Remove android-compose-ui from android"),
		);
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[0])).toBe(
			"rt-android-expert",
		);

		fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(2),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[1])).toBe(
			"rt-android-expert,android-compose-ui",
		);
	});
});

describe("Library bundle mode — case 4b: playbook row remove action", () => {
	it("names the skill in the remove button's accessible name (G12)", async () => {
		const { calls } = renderBundle(sampleRegistry, "android");

		expect(screen.queryByRole("button", { name: "Grid view" })).not.toBeInTheDocument();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Remove android-compose-ui from android",
			}),
		);

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[0])).toBe(
			"rt-android-expert",
		);
	});
});

describe("Library bundle mode — case 5: add skills popover", () => {
	it("appends a picked skill to the current membership", async () => {
		const { calls } = renderBundle(sampleRegistry, "android");
		// library-bundle-mode.journey.spec.ts "Add skills: toggling a
		// non-member adds it to the list" (~:145) checks the VISIBLE outcome
		// (the row appears, the list count grows) — the write-call assertion
		// below only proved the payload, not that the pick actually lands in
		// the rendered list.
		const before = document.querySelectorAll(".lib-list .skill-row").length;
		expect(screen.queryByText("brainstorm")).toBeNull();

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(
			await screen.findByRole("checkbox", { name: /brainstorm/i }),
		);

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);
		await waitFor(() =>
			expect(document.querySelectorAll(".lib-list .skill-row")).toHaveLength(
				before + 1,
			),
		);
		const rowTexts = [...document.querySelectorAll(".lib-list .skill-row")].map(
			(row) => row.textContent ?? "",
		);
		expect(rowTexts.some((text) => text.includes("brainstorm"))).toBe(true);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[0])).toBe(
			"rt-android-expert,android-compose-ui,brainstorm",
		);
	});

	it("creates a skill, adds it to the bundle, and opens it with a bundle return", async () => {
		const { calls } = renderBundleForRename(sampleRegistry, "android");

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));

		const dialog = await screen.findByRole("dialog", { name: "New skill" });
		expect(within(dialog).getByText("android")).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "bundle-helper" },
		});
		fireEvent.change(screen.getByPlaceholderText("One-line description…"), {
			target: { value: "Helps this bundle." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		await waitFor(() =>
			expect(calls).toContainEqual([
				"new",
				"skill",
				"bundle-helper",
				"--type",
				"claude-skill",
				"--scope",
				"global",
				"--description",
				"Helps this bundle.",
			]),
		);

		// The sheet closes on the durable write + registry refetch; the route
		// stays on the bundle rather than jumping to the editor.
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");

		await waitFor(() =>
			expect(skillsArg(findBundleUpdateCall(calls, "android")[0])).toBe(
				"rt-android-expert,android-compose-ui,bundle-helper",
			),
		);

		const toast = await waitFor(() => {
			const found = useAppStore
				.getState()
				.toasts.find(
					(t) => t.title === 'Created "bundle-helper" and added it to "android"',
				);
			expect(found).toBeDefined();
			return found!;
		});
		expect(toast.action?.label).toBe("Open");

		act(() => toast.action!.onClick());
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/skill/bundle-helper"),
		);
		expect(screen.getByTestId("loc")).toHaveAttribute("data-from", "/bundle/android");
	});

	it("keeps and opens the created skill when adding it to the bundle fails", async () => {
		const { calls } = renderBundleForRename(sampleRegistry, "android", (args) =>
			args[0] === "bundle" && args[1] === "update"
				? { success: false, output: "bundle write failed" }
				: undefined,
		);

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "safe-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		await waitFor(() =>
			expect(calls.some((args) => args[0] === "new" && args[2] === "safe-helper")).toBe(true),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);
		// The sheet never navigated to the editor — the skill exists, but the
		// addition failed, and the route stays on the bundle.
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");

		const process = await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.target === "bundle-add:android:safe-helper",
			);
			expect(p).toBeDefined();
			expect(p!.status).toBe("error");
			return p!;
		});
		expect(process.retry).not.toBeNull();
		expect(process.body).toMatch(
			/^Created "safe-helper"\. Couldn't add it to "android":/,
		);

		expect(
			useAppStore
				.getState()
				.toasts.find((t) => t.title.includes("but couldn't add it")),
		).toBeUndefined();

		// The membership hook's own rollback removed the optimistic row.
		await waitFor(() => expect(screen.queryByText("safe-helper")).toBeNull());
	});

	it("closes the sheet before a held bundle update resolves, then fires the toast", async () => {
		const pending = deferredResult();
		const { calls } = renderBundleForRename(sampleRegistry, "android", (args) =>
			args[0] === "bundle" && args[1] === "update" ? pending.promise : undefined,
		);

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "pending-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		await waitFor(() =>
			expect(calls.some((a) => a[0] === "new" && a[2] === "pending-helper")).toBe(true),
		);
		// Gone before the held write ever settles.
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
		expect(
			useAppStore
				.getState()
				.toasts.find((t) => t.title.startsWith('Created "pending-helper"')),
		).toBeUndefined();

		await act(async () => pending.resolve({ success: true, output: "" }));

		await waitFor(() =>
			expect(
				useAppStore
					.getState()
					.toasts.find(
						(t) => t.title === 'Created "pending-helper" and added it to "android"',
					),
			).toBeDefined(),
		);
	});

	// Regression: a registry refetch DISPATCHED before the bundle-membership
	// optimistic write, but RESOLVING after it with a pre-write snapshot, used
	// to clobber the optimistic member list a few ticks later — the new row
	// would vanish (bundle mode only lists current members) until the write
	// landed. In the live app the sheet's own un-awaited registry refetch was
	// the first source of such a stale reply (since removed, design.md
	// Decision 11); any other in-flight refetch — a window-focus refetch, a
	// neighbour's invalidation — races the same way. `useBundleMembership`
	// now cancels the in-flight registry fetch right before its optimistic
	// write (Decision 10), so react-query discards the stale reply instead of
	// applying it. The test dispatches that stale refetch itself and holds
	// its reply until after the optimistic write has landed.
	it("keeps the optimistic member row when a stale registry refetch resolves after it", async () => {
		const gate = makeRegistryReadGate();
		const client = makeQueryClient();
		primeRegistry(client, sampleRegistry);
		const bundleUpdate = deferredResult();
		const calls = mockHub(
			client,
			(args) => (args[0] === "bundle" && args[1] === "update" ? bundleUpdate.promise : undefined),
			gate,
		);
		renderWithProviders(
			<>
				<Routes>
					<Route path="/bundle/:name" element={<SkillLibrary />} />
				</Routes>
				<ToastContainer />
			</>,
			{ client, initialRoute: "/bundle/android" },
		);
		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		const brainstorm = await screen.findByRole("checkbox", { name: /brainstorm/i });
		const memberRow = () =>
			screen
				.queryAllByText("brainstorm")
				.map((el) => el.closest(".skill-row"))
				.find((el): el is HTMLElement => el instanceof HTMLElement) ?? null;
		expect(memberRow()).toBeNull();

		// A registry refetch goes out NOW and its reply is held: the mock
		// captured its snapshot at call time, before the add below.
		const readsBefore = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "read_registry").length;
		gate.armHold();
		void client.invalidateQueries({ queryKey: qk.registry() });
		await waitFor(() =>
			expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "read_registry").length).toBe(
				readsBefore + 1,
			),
		);

		fireEvent.click(brainstorm);
		// The optimistic write has landed by the time the bundle write is issued.
		await waitFor(() => expect(findBundleUpdateCall(calls, "android")).toHaveLength(1));
		expect(memberRow()).not.toBeNull();

		// Release the stale reply. Awaiting only `gate.settled` (the mock's own
		// promise) is not enough: react-query's internal fetch bookkeeping and
		// React's re-render are a SEPARATE promise chain that `act`'s flushing
		// does not wait for once this callback's own promise resolves. A real
		// macrotask tick makes the check below land on the settled state.
		await act(async () => {
			gate.release();
			await gate.settled;
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		// Without the cancel, the stale pre-add snapshot lands here and the
		// row disappears while the write is still in flight.
		expect(memberRow()).not.toBeNull();
		expect(findBundleUpdateCall(calls, "android")).toHaveLength(1);

		await act(async () => bundleUpdate.resolve({ success: true, output: "" }));
		expect(memberRow()).not.toBeNull();
	});

	it("retries the failed addition without creating the skill again, and shows the success toast with Open", async () => {
		let bundleCallCount = 0;
		const { calls } = renderBundleWithProbe(sampleRegistry, "android", (args) => {
			if (args[0] === "bundle" && args[1] === "update") {
				bundleCallCount += 1;
				return bundleCallCount === 1
					? { success: false, output: "bundle write failed" }
					: { success: true, output: "" };
			}
			return undefined;
		});

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "retry-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		const process = await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.target === "bundle-add:android:retry-helper",
			);
			expect(p).toBeDefined();
			expect(p!.status).toBe("error");
			return p!;
		});
		expect(findBundleUpdateCall(calls, "android")).toHaveLength(1);
		const firstCsv = skillsArg(findBundleUpdateCall(calls, "android")[0]);
		// No toast yet — the first (failed) run's own promise chain owns no
		// success toast, and the card + `useBundleMembership`'s own error toast
		// are the only reports so far.
		expect(
			useAppStore
				.getState()
				.toasts.find((t) => t.title.startsWith('Created "retry-helper"')),
		).toBeUndefined();

		act(() => process.retry!());

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(2),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[1])).toBe(firstCsv);
		expect(calls.filter((a) => a[0] === "new")).toHaveLength(1);

		// Regression: the success toast (with Open) used to be wired only to
		// the FIRST `runBundleAddition` call's promise, so a Retry that
		// succeeds fired no toast at all — Retry now pushes its own.
		const toast = await waitFor(() => {
			const found = useAppStore
				.getState()
				.toasts.find(
					(t) => t.title === 'Created "retry-helper" and added it to "android"',
				);
			expect(found).toBeDefined();
			return found!;
		});
		expect(toast.action?.label).toBe("Open");
		expect(toast.duration).toBe(7000);
	});

	it("leaves the card in error without throwing when a retry fails a second time", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const { calls } = renderBundleWithProbe(sampleRegistry, "android", (args) =>
				args[0] === "bundle" && args[1] === "update"
					? { success: false, output: "bundle write failed" }
					: undefined,
			);

			fireEvent.click(await screen.findByTestId("bundle-add-skills"));
			fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
			fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
				target: { value: "double-fail-helper" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

			// Each `runBundleAddition` call starts a FRESH process under the same
			// target (`trackProcess` -> `Processes.start`), so `.find` (first
			// match) would keep returning the original, already-failed entry
			// forever — read the LATEST entry for this target instead.
			const forTarget = () =>
				Processes.list().filter((p) => p.target === "bundle-add:android:double-fail-helper");

			const trackedProcess = await waitFor(() => {
				const list = forTarget();
				expect(list).toHaveLength(1);
				expect(list[0].status).toBe("error");
				return list[0];
			});
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1);

			act(() => trackedProcess.retry!());

			await waitFor(() =>
				expect(findBundleUpdateCall(calls, "android")).toHaveLength(2),
			);
			const retried = await waitFor(() => {
				const list = forTarget();
				expect(list).toHaveLength(2);
				expect(list[1].status).toBe("error");
				return list[1];
			});
			expect(retried.id).not.toBe(trackedProcess.id);
			expect(retried.retry).not.toBeNull();
			// A second retry never created the skill again, and the mock's own
			// awaited settling above is proof the rejection was handled — it
			// never reached the process-level `unhandledRejection` listener.
			expect(calls.filter((a) => a[0] === "new")).toHaveLength(1);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("succeeds the card and shows an info toast when the write landed but sync warned", async () => {
		const { calls } = renderBundleWithProbe(sampleRegistry, "android", (args) =>
			args[0] === "bundle" && args[1] === "update"
				? {
						success: false,
						output:
							JSON.stringify({
								bundle: {
									name: "android",
									skills: ["rt-android-expert", "android-compose-ui", "landed-helper"],
								},
								changed: true,
								warnings: [],
								errors: [],
							}) + "\ndoctor: 1 finding",
					}
				: undefined,
		);

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "landed-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		await waitFor(() =>
			expect(calls.some((a) => a[0] === "new" && a[2] === "landed-helper")).toBe(true),
		);
		await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.target === "bundle-add:android:landed-helper",
			);
			expect(p).toBeDefined();
			expect(p!.status).toBe("success");
		});
		await waitFor(() =>
			expect(
				useAppStore.getState().toasts.find((t) => t.title === "Sync reported findings"),
			).toBeDefined(),
		);
		expect(
			useAppStore
				.getState()
				.toasts.find(
					(t) => t.title === 'Created "landed-helper" and added it to "android"',
				),
		).toBeDefined();
	});

	it("keeps ordered writes when a second creation starts before the first settles", async () => {
		const first = deferredResult();
		let bundleCallCount = 0;
		const { calls } = renderBundleWithProbe(sampleRegistry, "android", (args) => {
			if (args[0] === "bundle" && args[1] === "update") {
				bundleCallCount += 1;
				return bundleCallCount === 1 ? first.promise : { success: true, output: "" };
			}
			return undefined;
		});

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "first-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "second-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);

		await waitFor(() =>
			expect(calls.some((a) => a[0] === "new" && a[2] === "second-helper")).toBe(true),
		);
		// The second write has not run yet — it is queued behind the first.
		expect(findBundleUpdateCall(calls, "android")).toHaveLength(1);

		await act(async () => first.resolve({ success: true, output: "" }));

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(2),
		);
		const [firstCall, secondCall] = findBundleUpdateCall(calls, "android");
		expect(skillsArg(firstCall)).toBe(
			"rt-android-expert,android-compose-ui,first-helper",
		);
		expect(skillsArg(secondCall)).toContain("first-helper");
	});

	it("still fires the settle toast after navigating away mid-flight", async () => {
		const pending = deferredResult();
		renderBundleWithProbe(sampleRegistry, "android", (args) =>
			args[0] === "bundle" && args[1] === "update" ? pending.promise : undefined,
		);

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "roaming-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);

		const pill = await screen.findByTestId("bundle-context-pill");
		fireEvent.click(pill);
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/"));

		await act(async () => pending.resolve({ success: true, output: "" }));

		await waitFor(() =>
			expect(
				useAppStore
					.getState()
					.toasts.find(
						(t) => t.title === 'Created "roaming-helper" and added it to "android"',
					),
			).toBeDefined(),
		);
		await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.target === "bundle-add:android:roaming-helper",
			);
			expect(p).toBeDefined();
			expect(p!.status).toBe("success");
		});
	});

	it("registers an existing MCP server from the bundle sheet with Registered wording", async () => {
		const { calls } = renderBundleForRename(sampleRegistry, "android");

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));

		fireEvent.change(screen.getAllByRole("combobox")[0], {
			target: { value: "mcp-server" },
		});
		const textarea = await screen.findByPlaceholderText(/mcp\.example\.com/);
		fireEvent.change(textarea, {
			target: { value: '{"type":"http","url":"https://mcp.example.com/mcp"}' },
		});
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "docs-mcp" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add server to bundle" }));

		await waitFor(() =>
			expect(
				calls.some((a) => a[0] === "mcp" && a[1] === "add" && a[2] === "docs-mcp"),
			).toBe(true),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");

		await waitFor(() =>
			expect(skillsArg(findBundleUpdateCall(calls, "android")[0])).toBe(
				"rt-android-expert,android-compose-ui,docs-mcp",
			),
		);
		await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.target === "bundle-add:android:docs-mcp",
			);
			expect(p).toBeDefined();
			expect(p!.status).toBe("success");
		});
		expect(
			useAppStore
				.getState()
				.toasts.find(
					(t) => t.title === 'Registered "docs-mcp" and added it to "android"',
				),
		).toBeDefined();
	});

	it("focuses the MCP panel when the success toast's Open action is clicked", async () => {
		const { calls } = renderBundleForRename(sampleRegistry, "android");

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));

		fireEvent.change(screen.getAllByRole("combobox")[0], {
			target: { value: "mcp-server" },
		});
		const textarea = await screen.findByPlaceholderText(/mcp\.example\.com/);
		fireEvent.change(textarea, {
			target: { value: '{"type":"http","url":"https://mcp.example.com/mcp"}' },
		});
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "docs-mcp" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add server to bundle" }));

		await waitFor(() =>
			expect(
				calls.some((a) => a[0] === "mcp" && a[1] === "add" && a[2] === "docs-mcp"),
			).toBe(true),
		);
		const toast = await waitFor(() => {
			const t = useAppStore
				.getState()
				.toasts.find(
					(t) => t.title === 'Registered "docs-mcp" and added it to "android"',
				);
			expect(t).toBeDefined();
			return t!;
		});

		// `focusMcpPanelWhenReady` (newSkillCompletion.ts) polls the whole
		// document for `[data-testid="mcp-panel"]` via requestAnimationFrame,
		// not a query scoped to whatever the app happens to have routed to —
		// a plain DOM node appended straight to `document.body` is enough to
		// exercise it without wiring a real `/skill/:name` route into this
		// bundle-only render tree.
		const panel = document.createElement("div");
		panel.setAttribute("data-testid", "mcp-panel");
		panel.tabIndex = -1;
		document.body.appendChild(panel);

		act(() => {
			toast.action!.onClick();
		});
		await act(async () => {
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => requestAnimationFrame(r));
		});

		expect(document.activeElement).toHaveAttribute("data-testid", "mcp-panel");
		document.body.removeChild(panel);
	});

	// create-from-bundle.journey.spec.ts: "creating a skill from a bundle
	// closes the sheet early and shows the pending row while the write
	// settles" — the `.lds-status-working` text itself is StatusBar's job
	// (StatusBar.test.tsx), so this only proves the running process this
	// screen tracks carries the exact title that segment renders.
	it("marks the created skill's row pending while the bundle write is held, then clears it", async () => {
		const pending = deferredResult();
		renderBundleForRename(sampleRegistry, "android", (args) =>
			args[0] === "bundle" && args[1] === "update" ? pending.promise : undefined,
		);

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "pending-row-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		// The row (SkillRow -> ResourceRow) is `role="button"` with the skill
		// name as its accessible name — design.md Decisions #4.
		const row = await screen.findByRole("button", { name: "pending-row-helper" });
		await waitFor(() => expect(row).toHaveAttribute("aria-busy", "true"));
		expect(within(row).getByText("adding…")).toBeInTheDocument();

		const runningProcess = await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.target === "bundle-add:android:pending-row-helper",
			);
			expect(p).toBeDefined();
			expect(p!.status).toBe("running");
			return p!;
		});
		expect(runningProcess.title).toBe("Adding pending-row-helper to android");

		await act(async () => pending.resolve({ success: true, output: "" }));

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "pending-row-helper" }),
			).not.toHaveAttribute("aria-busy", "true"),
		);
		expect(
			within(screen.getByRole("button", { name: "pending-row-helper" })).queryByText(
				"adding…",
			),
		).toBeNull();
	});

	it("moves focus to the Add skills button once the sheet closes", async () => {
		renderBundleForRename(sampleRegistry, "android");

		const addSkillsButton = await screen.findByTestId("bundle-add-skills");
		fireEvent.click(addSkillsButton);
		fireEvent.click(await screen.findByRole("button", { name: "Create new skill" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), {
			target: { value: "focus-return-helper" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create and add" }));

		// `Modal` would otherwise restore focus to the (by-then-unmounted)
		// "Create new skill" popover button, dropping it to `body`.
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New skill" })).toBeNull(),
		);
		await waitFor(() => expect(document.activeElement).toBe(addSkillsButton));
	});
});

// ─── Linked / global / unknown ────────────────────────────────────────────

function makeLinkedRegistry(): Registry {
	return {
		version: "1",
		hub_path: "~/h",
		skills: {
			"org-lint": {
				version: "1.0.0",
				description: "External lint rules.",
				source: "~/h/sources/org-skills/worktree/skills/org-lint",
				type: "claude-skill",
				scope: "portable",
				upstream: "git@github.com:org/skills.git",
				managed: "external",
				origin: { source: "org-skills", source_type: "git" },
			},
		},
		projects: {},
		bundles: {
			"org-pack": {
				description: "Everything Org Skills ships",
				icon: "🔗",
				scope: "project-specific",
				skills: ["org-lint"],
				source: "org-skills",
			},
		},
		sources: {
			"org-skills": {
				type: "git",
				name: "Org Skills",
				url: "git@github.com:org/skills.git",
				status: "up-to-date",
			},
		},
	};
}

describe("Library bundle mode — case 6: linked bundle", () => {
	it("locks membership and shows the lock glyph, never a remove action", async () => {
		renderBundle(makeLinkedRegistry(), "org-pack");

		expect(await screen.findByTestId("bundle-linked-lock")).toBeInTheDocument();
		expect(screen.queryByTestId("bundle-add-skills")).toBeNull();
		expect(screen.queryByLabelText(/Remove org-lint from/)).toBeNull();
		expect(screen.getByTitle("Managed by Org Skills")).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("overflow-trigger"));
		expect(
			screen.getByRole("menuitem", { name: "Detach from source…" }),
		).toBeInTheDocument();
	});
});

function makeGlobalRegistry(): Registry {
	return {
		version: "1",
		hub_path: "~/h",
		skills: {
			"local-helper": {
				version: "1.0.0",
				description: "A local skill.",
				source: "~/h/skills/local-helper",
				type: "claude-skill",
				scope: "portable",
				upstream: null,
				managed: "local",
			},
		},
		projects: { p1: { path: "/p1", bundles: [], enabled: [] } },
		bundles: {
			"always-on": {
				description: "Always on",
				icon: "🌐",
				scope: "global",
				skills: ["local-helper"],
			},
		},
	};
}

describe("Library bundle mode — case 7: global bundle", () => {
	it("shows the auto-applied tag and drops the Applied-to chip", async () => {
		renderBundle(makeGlobalRegistry(), "always-on");

		expect(await screen.findByText("auto-applied everywhere")).toBeInTheDocument();
		expect(screen.queryByTestId("bundle-applied-chip")).toBeNull();
	});
});

describe("Library bundle mode — case 8: unknown bundle", () => {
	it("shows the not-found EmptyState and no band", async () => {
		renderBundle(sampleRegistry, "nope");

		const empty = (
			await screen.findByText('Bundle "nope" not found')
		).closest(".empty-state") as HTMLElement;
		expect(screen.queryByTestId("library-bundle-band")).toBeNull();
		expect(
			within(empty).getByRole("button", { name: "Back to Library" }),
		).toBeInTheDocument();
	});
});

// ─── Missing members (G3) ─────────────────────────────────────────────────

function makeMissingMemberRegistry(): Registry {
	return {
		version: "1",
		hub_path: "~/h",
		skills: {
			brainstorm: {
				version: "1.0.0",
				description: "Brainstorm.",
				source: "~/h/skills/brainstorm",
				type: "claude-skill",
				scope: "global",
				upstream: null,
				managed: "local",
			},
		},
		projects: {},
		bundles: {
			"legacy-tools": {
				description: "Old kit",
				icon: "🧰",
				scope: "project-specific",
				// "retired-skill" is not in `skills` above — the source it came
				// from dropped it; the bundle still lists it.
				skills: ["brainstorm", "retired-skill"],
			},
		},
	};
}

describe("Library bundle mode — case 9: missing members", () => {
	it("shows the missing count and filters a row removal to known names", async () => {
		const { calls } = renderBundle(makeMissingMemberRegistry(), "legacy-tools");

		expect(await screen.findByTestId("bundle-missing-tag")).toHaveTextContent(
			"1 missing",
		);

		// A row remove drops the KNOWN member; the missing name never rides
		// along in the csv (the real CLI would refuse it if it did).
		fireEvent.click(
			await screen.findByLabelText("Remove brainstorm from legacy-tools"),
		);
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "legacy-tools")).toHaveLength(1),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "legacy-tools")[0])).toBe("");
	});

	it("'Remove missing skills' writes the known-only csv", async () => {
		const { calls } = renderBundle(makeMissingMemberRegistry(), "legacy-tools");
		await screen.findByTestId("bundle-missing-tag");

		fireEvent.click(screen.getByTestId("overflow-trigger"));
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Remove missing skills" }),
		);

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "legacy-tools")).toHaveLength(1),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "legacy-tools")[0])).toBe(
			"brainstorm",
		);
	});

	// Finding #9: G3's registry-unknown filter runs on EVERY op, not just
	// "Remove missing skills" — so adding one skill via the band picker was
	// ALSO silently dropping "retired-skill" with no feedback at all.
	it("surfaces a member silently dropped by an unrelated op", async () => {
		const registry = makeMissingMemberRegistry();
		registry.skills["new-tool"] = {
			version: "1.0.0",
			description: "A new tool.",
			source: "~/h/skills/new-tool",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		};
		const { calls } = renderBundle(registry, "legacy-tools");
		await screen.findByTestId("bundle-missing-tag");

		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(await screen.findByRole("checkbox", { name: /new-tool/i }));

		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "legacy-tools")).toHaveLength(1),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "legacy-tools")[0])).toBe(
			"brainstorm,new-tool",
		);
		expect(
			await screen.findByText("Also dropped 1 member no longer in the library"),
		).toBeInTheDocument();
		expect(screen.getByText("retired-skill")).toBeInTheDocument();
	});
});

// ─── Undo across an intervening edit (G4) ─────────────────────────────────

describe("Library bundle mode — case 10: undo after a second edit", () => {
	it("undo re-inserts at the original index into the LATEST membership", async () => {
		const { calls } = renderBundle(sampleRegistry, "android");

		// Remove android-compose-ui (original index 1) — toast + Undo appear.
		fireEvent.click(
			await screen.findByLabelText("Remove android-compose-ui from android"),
		);
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(1),
		);

		// While the undo toast is up, add brainstorm via the band picker.
		fireEvent.click(await screen.findByTestId("bundle-add-skills"));
		fireEvent.click(
			await screen.findByRole("checkbox", { name: /brainstorm/i }),
		);
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(2),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[1])).toBe(
			"rt-android-expert,brainstorm",
		);

		// Undo re-inserts android-compose-ui at its ORIGINAL index (1) into the
		// CURRENT list — never a replay of the pre-edit csv (which would have
		// silently dropped brainstorm).
		fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
		await waitFor(() =>
			expect(findBundleUpdateCall(calls, "android")).toHaveLength(3),
		);
		expect(skillsArg(findBundleUpdateCall(calls, "android")[2])).toBe(
			"rt-android-expert,android-compose-ui,brainstorm",
		);
	});
});

function makeEmptyBundleRegistry(): Registry {
	return {
		version: "1",
		hub_path: "~/h",
		skills: {},
		projects: {},
		bundles: {
			empty: { description: "", icon: "📦", scope: "project-specific", skills: [] },
		},
	};
}

// ─── Header rename ─────────────────────────────────────────────────────────

/** Same as `renderBundleWithProbe`, but the probe is a PERMANENT sibling
 *  (not a catch-all route): a rename lands on `/bundle/<new>`, which still
 *  matches the SAME `/bundle/:name` route, so a catch-all `*` route would
 *  never mount to report it — the same pattern `ProjectRename.test.tsx`
 *  uses for a project rename. */
function renderBundleForRename(
	registry: Registry,
	name: string,
	override?: (a: string[]) => { success: boolean; output: string } | Promise<{ success: boolean; output: string }> | undefined,
	withNav = false,
	registryReadGate?: ReturnType<typeof makeRegistryReadGate>,
) {
	const client = makeQueryClient();
	primeRegistry(client, registry);
	const calls = mockHub(client, override, registryReadGate);
	renderWithProviders(
		<>
			<LocationProbe />
			{withNav && <NavPanel />}
			<Routes>
				<Route path="/bundle/:name" element={<SkillLibrary />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: `/bundle/${name}` },
	);
	return { client, calls };
}

function makeTwoBundleRegistry(): Registry {
	return {
		...sampleRegistry,
		bundles: {
			...sampleRegistry.bundles,
			existing: { description: "", icon: "📦", scope: "project-specific", skills: [] },
		},
	};
}

describe("Library bundle mode — case 11: header rename", () => {
	it("right-clicks an unselected sidebar bundle, cancels, then reopens its context menu", async () => {
		const { calls } = renderBundleForRename(makeTwoBundleRegistry(), "android", undefined, true);
		expect(screen.queryByRole("button", { name: "Actions for existing" })).toBeNull();
		expect(screen.getAllByTestId("overflow-trigger")).toHaveLength(1);
		const row = screen.getByRole("button", { name: /existing 0$/ });
		fireEvent.contextMenu(row);
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename bundle…" }));
		const field = await screen.findByRole("textbox", { name: "Bundle name" });
		await waitFor(() => expect(field).toHaveFocus());
		expect(field).toHaveValue("existing");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("textbox", { name: "Bundle name" })).toBeNull();
		expect(calls.filter((a) => a[1] === "rename")).toEqual([]);
		fireEvent.contextMenu(row);
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename bundle…" }));
		await waitFor(() => expect(screen.getByRole("textbox", { name: "Bundle name" })).toHaveFocus());
		await userEvent.keyboard("renamed{Enter}");
		await waitFor(() => expect(calls).toContainEqual(["bundle", "rename", "existing", "renamed"]));
	});

	it("opens the sidebar menu with Shift+F10 and returns focus on Escape", async () => {
		renderBundleForRename(sampleRegistry, "android", undefined, true);
		const row = screen.getByRole("button", { name: /android 2$/ });
		row.focus();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename bundle…" })).toHaveFocus());
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(row).toHaveFocus());
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
	});

	it("opens the existing rename field from the header menu and keeps keyboard focus", async () => {
		const { calls } = renderBundleForRename(sampleRegistry, "android");
		await userEvent.click(screen.getByTestId("overflow-trigger"));
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename bundle…" }));
		const field = await screen.findByRole("textbox", { name: "Bundle name" });
		await waitFor(() => expect(field).toHaveFocus());
		expect((field as HTMLInputElement).selectionStart).toBe(0);
		expect((field as HTMLInputElement).selectionEnd).toBe(7);
		await userEvent.keyboard("droid{Enter}");
		await waitFor(() => expect(calls).toContainEqual(["bundle", "rename", "android", "droid"]));
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/droid"));
	});

	it("renames through `hub bundle rename`, follows the new route, and undoes back", async () => {
		const { calls } = renderBundleForRename(sampleRegistry, "android");

		await userEvent.click(
			screen.getByRole("button", { name: "Rename bundle name: android" }),
		);
		const field = screen.getByRole("textbox", { name: "Bundle name" });
		await userEvent.clear(field);
		await userEvent.type(field, "droid");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(calls).toContainEqual(["bundle", "rename", "android", "droid"]),
		);
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/droid"),
		);
		expect(
			useAppStore
				.getState()
				.toasts.find((t) => t.title === "Renamed android to droid"),
		).toBeDefined();

		fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
		await waitFor(() =>
			expect(calls).toContainEqual(["bundle", "rename", "droid", "android"]),
		);
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android"),
		);
	});

	it("refuses a name another bundle already holds, and never calls hub_cmd", async () => {
		const { calls } = renderBundleForRename(makeTwoBundleRegistry(), "android");

		await userEvent.click(
			screen.getByRole("button", { name: "Rename bundle name: android" }),
		);
		const field = screen.getByRole("textbox", { name: "Bundle name" });
		await userEvent.clear(field);
		await userEvent.type(field, "existing");

		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(field).toHaveAttribute(
			"title",
			"A bundle with this name already exists",
		);

		await userEvent.keyboard("{Enter}");
		expect(calls.some((a) => a[0] === "bundle" && a[1] === "rename")).toBe(false);
	});

	it("surfaces a failed rename and keeps the field open", async () => {
		const { calls } = renderBundleForRename(
			sampleRegistry,
			"android",
			(a) =>
				a[0] === "bundle" && a[1] === "rename"
					? { success: false, output: "Bundle 'droid' already exists." }
					: undefined,
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Rename bundle name: android" }),
		);
		const field = screen.getByRole("textbox", { name: "Bundle name" });
		await userEvent.clear(field);
		await userEvent.type(field, "droid");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(
				useAppStore.getState().toasts.find((t) => t.title === "Couldn't rename bundle"),
			).toBeDefined(),
		);
		expect(calls).toContainEqual(["bundle", "rename", "android", "droid"]);
		expect(screen.getByRole("textbox", { name: "Bundle name" })).toHaveValue("droid");
		expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
	});
});

describe("Library bundle mode — floating search context pill", () => {
	it("renders even with an empty pool", async () => {
		renderBundle(makeEmptyBundleRegistry(), "empty");

		expect(await screen.findByText("Empty bundle")).toBeInTheDocument();
		const pill = await screen.findByTestId("bundle-context-pill");
		expect(within(pill).getByText("empty")).toBeInTheDocument();
	});

	// Finding #8: the title promised the pill's exit behaves, but the body
	// only ever asserted the pill RENDERED — `context.onClear` (`navigate("/")`)
	// was never actually exercised.
	it("clears back to the library when the pill's × is clicked", async () => {
		renderBundleWithProbe(makeEmptyBundleRegistry(), "empty");

		// The pill itself IS the button (`context.onClear`, with a trailing ×
		// glyph) — not a container with a separate close button inside it.
		const pill = await screen.findByTestId("bundle-context-pill");
		fireEvent.click(pill);

		// Exact match: "/" is a substring of "/bundle/empty" too, so a loose
		// match would pass even if the pill left the route unchanged.
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/));
	});
});

type HubResult = { success: boolean; output: string };

function deferredResult() {
	let resolve!: (result: HubResult) => void;
	const promise = new Promise<HubResult>((done) => { resolve = done; });
	return { promise, resolve };
}

function savedScope(scope: "global" | "project-specific", success = true): HubResult {
	return {
		success,
		output: JSON.stringify({ bundle: { scope }, changed: true, warnings: [], errors: [] }) +
			(success ? "" : "\nSync reported a danger finding"),
	};
}

function scopeCalls(calls: string[][]) {
	return calls.filter((a) => a[0] === "bundle" && a[1] === "update" && a.includes("--scope"));
}

async function openGlobalSwitch() {
	await userEvent.click(screen.getByTestId("overflow-trigger"));
	return screen.getByRole("menuitemcheckbox", { name: "Global" });
}

describe("Library bundle mode — global scope switch", () => {
	it("round trips scope and preserves skills, description, icon and project assignments", async () => {
		const before = structuredClone(sampleRegistry);
		const { client, calls } = renderBundle(before, "android", (args) =>
			args.includes("--scope") ? savedScope(args[4] as "global" | "project-specific") : undefined,
		);
		const toggle = await openGlobalSwitch();
		expect(toggle).not.toBeChecked();
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.getByText("auto-applied everywhere")).toBeVisible());
		expect(toggle).toBeChecked();
		expect(screen.queryByTestId("bundle-applied-chip")).toBeNull();
		expect(client.getQueryData<Registry>(qk.registry())?.bundles.android).toEqual({
			...before.bundles.android, scope: "global",
		});
		await waitFor(() => expect(toggle).not.toHaveAttribute("aria-busy"));
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.getByTestId("bundle-applied-chip")).toBeEnabled());
		expect(toggle).not.toBeChecked();
		expect(scopeCalls(calls)).toEqual([
			["bundle", "update", "android", "--scope", "global", "--json"],
			["bundle", "update", "android", "--scope", "project-specific", "--json"],
		]);
		const after = client.getQueryData<Registry>(qk.registry());
		expect(after?.bundles.android).toEqual({ ...before.bundles.android, scope: "project-specific" });
		expect(after?.projects).toEqual(before.projects);
		expect(screen.getByRole("menu")).toBeVisible();
	});

	it("changes a linked bundle without detaching or replacing its membership", async () => {
		const before = makeLinkedRegistry();
		const { client, calls } = renderBundle(before, "org-pack", (args) =>
			args.includes("--scope") ? savedScope("global") : undefined,
		);
		const toggle = await openGlobalSwitch();
		expect(screen.getByText("Source changes reach every project when global")).toBeVisible();
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.getByText("auto-applied everywhere")).toBeVisible());
		expect(client.getQueryData<Registry>(qk.registry())?.bundles["org-pack"]).toEqual({
			...before.bundles["org-pack"], scope: "global",
		});
		expect(scopeCalls(calls)).toEqual([["bundle", "update", "org-pack", "--scope", "global", "--json"]]);
		expect(screen.getByTestId("bundle-linked-lock")).toBeVisible();
	});

	it("keeps busy state through the response, blocks repeats and Applied to, and survives menu dismissal", async () => {
		const pending = deferredResult();
		const { calls } = renderBundle(sampleRegistry, "android", (args) =>
			args.includes("--scope") ? pending.promise : undefined,
		);
		const trigger = screen.getByTestId("overflow-trigger");
		const toggle = await openGlobalSwitch();
		await userEvent.click(toggle);
		await waitFor(() => expect(scopeCalls(calls)).toHaveLength(1));
		expect(toggle).toHaveAttribute("aria-busy", "true");
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		expect(toggle).toBeChecked();
		expect(screen.getByTestId("bundle-applied-chip")).toBeDisabled();
		expect(screen.getByRole("menuitem", { name: "Delete bundle…" })).toBeDisabled();
		await userEvent.click(toggle);
		await userEvent.keyboard(" {Enter}");
		fireEvent.click(screen.getByTestId("bundle-applied-chip"));
		expect(scopeCalls(calls)).toHaveLength(1);
		expect(screen.queryByRole("listbox", { name: "Projects" })).toBeNull();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).toBeNull();
		// library-bundle-mode.journey.spec.ts "Global switch stays busy, blocks
		// repeated activation, and can be dismissed" (~:271) — the trigger
		// regains focus once the menu dismisses, even while the write is
		// still in flight.
		// The restore runs on a `requestAnimationFrame` tick (OverflowMenu.tsx)
		// — `waitFor` rather than a bare synchronous assertion, matching this
		// file's own "moves focus to the Add skills button" pattern above.
		await waitFor(() => expect(trigger).toHaveFocus());
		expect(screen.getByTestId("bundle-scope-saving")).toBeVisible();
		await act(async () => pending.resolve(savedScope("global")));
		await waitFor(() => expect(screen.queryByTestId("bundle-scope-saving")).toBeNull());
		expect(screen.getByText("auto-applied everywhere")).toBeVisible();
	});

	it("restores a global switch after a rejected write and allows retry", async () => {
		let fail = true;
		const { client, calls } = renderBundle(makeGlobalRegistry(), "always-on", (args) => {
			if (!args.includes("--scope")) return undefined;
			return fail ? { success: false, output: JSON.stringify({ bundle: null, errors: ["scope refused"] }) }
				: savedScope("project-specific");
		});
		const toggle = await openGlobalSwitch();
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.getByText("scope refused")).toBeVisible());
		expect(toggle).toBeChecked();
		expect(toggle).not.toHaveAttribute("aria-busy");
		expect(client.getQueryData<Registry>(qk.registry())?.bundles["always-on"].scope).toBe("global");
		fail = false;
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.getByTestId("bundle-applied-chip")).toBeEnabled());
		expect(toggle).not.toBeChecked();
		expect(scopeCalls(calls)).toHaveLength(2);
	});

	it("keeps a landed scope when sync reports a failure", async () => {
		const { client } = renderBundle(sampleRegistry, "android", (args) =>
			args.includes("--scope") ? savedScope("global", false) : undefined,
		);
		const toggle = await openGlobalSwitch();
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.getByText("Sync reported findings")).toBeVisible());
		expect(toggle).toBeChecked();
		expect(client.getQueryData<Registry>(qk.registry())?.bundles.android.scope).toBe("global");
		expect(screen.getByText("auto-applied everywhere")).toBeVisible();
		expect(screen.queryByText("Couldn't change bundle scope")).toBeNull();
	});

	it("queues scope behind an existing description write", async () => {
		const pending = deferredResult();
		const { calls } = renderBundle(sampleRegistry, "android", (args) => {
			if (args.some((arg) => arg.startsWith("--description="))) return pending.promise;
			if (args.includes("--scope")) return savedScope("global");
		});
		const description = screen.getByRole("textbox", { name: "Bundle description" });
		await userEvent.click(description);
		await userEvent.clear(description);
		await userEvent.type(description, "Updated description");
		await userEvent.tab();
		await waitFor(() => expect(calls.some((args) => args.includes("--description=Updated description"))).toBe(true));
		const toggle = await openGlobalSwitch();
		await userEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-busy", "true");
		expect(scopeCalls(calls)).toHaveLength(0);
		await act(async () => pending.resolve({ success: true, output: "" }));
		await waitFor(() => expect(screen.getByText("auto-applied everywhere")).toBeVisible());
		expect(scopeCalls(calls)).toHaveLength(1);
		expect(description).toHaveValue("Updated description");
	});

	it("disables Global during rename and never sends the stale name", async () => {
		const pending = deferredResult();
		const { calls } = renderBundleForRename(sampleRegistry, "android", (args) =>
			args[1] === "rename" ? pending.promise : undefined,
		);
		await userEvent.click(screen.getByRole("button", { name: "Rename bundle name: android" }));
		const field = screen.getByRole("textbox", { name: "Bundle name" });
		await userEvent.clear(field);
		await userEvent.type(field, "droid{Enter}");
		await waitFor(() => expect(calls).toContainEqual(["bundle", "rename", "android", "droid"]));
		const toggle = await openGlobalSwitch();
		expect(toggle).toBeDisabled();
		fireEvent.click(toggle);
		expect(scopeCalls(calls)).toHaveLength(0);
		await act(async () => pending.resolve({ success: true, output: "" }));
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/droid"));
	});
});

// ─── F9: Library bundle mode — delete-confirm blast radius + keyboard remove ──
// Moved from truthSyncSignal.test.tsx (TA-1-dfb7): this file already owns
// every other Library bundle mode case.
const truthSyncBundleRegistry: Registry = {
	version: "1",
	hub_path: "~/h",
	skills: {
		s1: {
			version: "1.0.0",
			description: "Only via b1.",
			source: "~/h/skills/s1",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
		},
	},
	projects: { p1: { path: "/p1", bundles: ["b1"], enabled: [] } },
	bundles: {
		b1: { description: "B1", icon: "📦", scope: "project-specific", skills: ["s1"] },
	},
};

describe("Library bundle mode safety", () => {
	function renderTruthSyncBundle() {
		const client = makeQueryClient();
		primeRegistry(client, truthSyncBundleRegistry);
		// `staleTime: 0` fires a background refetch of every active query on
		// mount; setup.ts's default reply doesn't cover these commands, and
		// react-query drops a query's data when its queryFn resolves
		// `undefined` — each needs a real reply so it never clobbers state.
		vi.mocked(invoke).mockImplementation(((cmd: string) => {
			if (cmd === "read_registry") return Promise.resolve(client.getQueryData(["registry"]));
			if (cmd === "local_skill_candidates" || cmd === "snippets_list") return Promise.resolve([]);
			if (cmd === "read_search_corpus") return Promise.resolve({ skills: {}, snippets: {} });
			return Promise.resolve({ success: true, output: "" });
		}) as never);
		renderWithProviders(
			<Routes>
				<Route path="/bundle/:name" element={<SkillLibrary />} />
			</Routes>,
			{ client, initialRoute: "/bundle/b1" },
		);
		return client;
	}

	it("delete routes through a confirm naming projects + skills that deactivate", async () => {
		renderTruthSyncBundle();
		// Overflow menu → the danger item opens the confirm (not an un-guarded delete).
		await userEvent.click(screen.getByTestId("overflow-trigger"));
		await userEvent.click(
			screen.getByRole("menuitem", { name: /Delete bundle…/ }),
		);
		expect(screen.getByText(/Delete bundle "b1"\?/)).toBeInTheDocument();
		expect(screen.getByText(/will deactivate/)).toBeInTheDocument();
		expect(screen.getByText(/p1 → s1/)).toBeInTheDocument();
	});

	it("Backspace on the focused list row removes it from the bundle", async () => {
		renderTruthSyncBundle();
		const row = await screen.findByText("s1");
		const listRow = row.closest(".lib-nav-row") as HTMLElement;
		expect(listRow).not.toBeNull();
		listRow.focus();
		fireEvent.keyDown(listRow, { key: "Backspace" });
		await waitFor(() =>
			expect(screen.getByText(/Empty bundle/)).toBeInTheDocument(),
		);
	});
});
