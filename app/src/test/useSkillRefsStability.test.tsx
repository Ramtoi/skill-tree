import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { renderHook, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "@/test/helpers";
import { NavigationGuard } from "@/lib/navGuard";
import { qk } from "@/lib/queryKeys";
import { useSkillRefs, type SkillRefsHost } from "@/hooks/useSkillRefs";
import { harnessDocBackTarget, type BackTarget } from "@/lib/backTarget";
import type { SearchCorpus } from "@/lib/unifiedSearch";
import type { Registry } from "@/types";

// A doc host (`self` absent) whose back target is the harness doc editor —
// stands in for any of the four doc hosts; the hook does not know or care
// which one it is.
const baseBack: BackTarget = harnessDocBackTarget("claude-code", "Claude Code");

const registry: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"code-review": {
			version: "1.0.0",
			description: "Review code for correctness and cleanup.",
			source: "~/skill-hub/skills/code-review",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
	},
};

const corpus: SearchCorpus = {
	skills: { orchestrate: "See `rt-android-expert` for the compose plan." },
	snippets: {},
};

function wrapperFor(client: ReturnType<typeof makeQueryClient>) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<NavigationGuard>{children}</NavigationGuard>
				</MemoryRouter>
			</QueryClientProvider>
		);
	};
}

function primeClient(over: { registry?: Registry; corpus?: SearchCorpus } = {}) {
	const client = makeQueryClient();
	primeRegistry(client, over.registry ?? registry);
	client.setQueryData(qk.searchCorpus(), over.corpus ?? corpus);
	return client;
}

describe("useSkillRefs — stability contract (constraint 3)", () => {
	it("keeps `extension` and `render` referentially stable across three `content` re-renders", () => {
		const client = primeClient();
		const host: SkillRefsHost = { back: baseBack };
		const { result, rerender } = renderHook(
			({ content }: { content: string }) => useSkillRefs({ host, content, registry }),
			{ wrapper: wrapperFor(client), initialProps: { content: "See `code-review`." } },
		);
		const firstExt = result.current.extension;
		const firstRender = result.current.render;

		rerender({ content: "See `code-review` again." });
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);

		rerender({ content: "See `code-review` a third time, and again." });
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);

		rerender({ content: "" });
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);
	});

	it("(backKey) keeps identity when host.back is a FRESH object literal every render", () => {
		const client = primeClient();
		const { result, rerender } = renderHook(
			() =>
				useSkillRefs({
					// A brand-new object literal every call — identity must not matter.
					host: { back: harnessDocBackTarget("claude-code", "Claude Code") },
					content: "See `code-review`.",
					registry,
				}),
			{ wrapper: wrapperFor(client) },
		);
		const firstExt = result.current.extension;
		const firstRender = result.current.render;

		rerender();
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);

		rerender();
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);
	});

	it("changes identity when back.path changes", () => {
		const client = primeClient();
		const { result, rerender } = renderHook(
			({ back }: { back: BackTarget }) =>
				useSkillRefs({ host: { back }, content: "See `code-review`.", registry }),
			{ wrapper: wrapperFor(client), initialProps: { back: baseBack } },
		);
		const firstExt = result.current.extension;
		const firstRender = result.current.render;

		rerender({ back: harnessDocBackTarget("codex", "Claude Code") });
		expect(result.current.extension).not.toBe(firstExt);
		expect(result.current.render).not.toBe(firstRender);
	});

	it("changes identity when back.crumbs changes", () => {
		const client = primeClient();
		const { result, rerender } = renderHook(
			({ back }: { back: BackTarget }) =>
				useSkillRefs({ host: { back }, content: "See `code-review`.", registry }),
			{ wrapper: wrapperFor(client), initialProps: { back: baseBack } },
		);
		const firstExt = result.current.extension;
		const firstRender = result.current.render;

		rerender({ back: { ...baseBack, crumbs: ["harness", "claude-code", "extra"] } });
		expect(result.current.extension).not.toBe(firstExt);
		expect(result.current.render).not.toBe(firstRender);
	});

	it("(F11 twin) does NOT change identity when only back.restore changes, and a click after that change navigates with the NEWEST restore payload", async () => {
		const client = primeClient();

		function TestHarness({ back }: { back: BackTarget }) {
			const view = useSkillRefs({ host: { back }, content: "See `code-review`.", registry });
			return (
				<button type="button" onClick={() => view.render.onOpen("code-review")}>
					open
				</button>
			);
		}

		function LocationProbe() {
			const loc = useLocation();
			return <div data-testid="loc" data-state={JSON.stringify(loc.state ?? null)}>{loc.pathname}</div>;
		}

		function Harness({ back }: { back: BackTarget }) {
			return (
				<Routes>
					<Route path="/harness/:id/doc" element={<TestHarness back={back} />} />
					<Route path="/skill/:name" element={<LocationProbe />} />
				</Routes>
			);
		}

		const { rerender } = renderWithProviders(<Harness back={{ ...baseBack, restore: { draft: "v1" } }} />, {
			client,
			initialRoute: "/harness/claude-code/doc",
		});

		// Re-render with only `restore` changed — a per-keystroke draft, in the
		// real snippet-create-form case. This must not be observable as a new
		// `render`/`extension` identity (pinned by the earlier tests); here we
		// just prove the click still picks up the LATEST payload.
		rerender(<Harness back={{ ...baseBack, restore: { draft: "v2" } }} />);

		fireEvent.click(screen.getByText("open"));
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/skill/code-review"));
		const state = JSON.parse(screen.getByTestId("loc").dataset.state ?? "null");
		expect(state).toEqual({ from: { ...baseBack, restore: { draft: "v2" } } });
	});

	it("(wrapNavigate seam) keeps `extension` and `render` identity when host.wrapNavigate is a FRESH function every render", () => {
		const client = primeClient();
		const { result, rerender } = renderHook(
			() =>
				useSkillRefs({
					// A brand-new function every call — identity must not matter.
					host: { back: baseBack, wrapNavigate: (go) => go() },
					content: "See `code-review`.",
					registry,
				}),
			{ wrapper: wrapperFor(client) },
		);
		const firstExt = result.current.extension;
		const firstRender = result.current.render;

		rerender();
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);

		rerender();
		expect(result.current.extension).toBe(firstExt);
		expect(result.current.render).toBe(firstRender);
	});

	it("(wrapNavigate seam) a click runs the NEWEST wrapNavigate, which performs the navigation", async () => {
		const client = primeClient();
		const firstWrap = vi.fn((go: () => void) => go());
		const secondWrap = vi.fn((go: () => void) => go());

		function TestHarness({ wrapNavigate }: { wrapNavigate: (go: () => void) => void }) {
			const view = useSkillRefs({
				host: { back: baseBack, wrapNavigate },
				content: "See `code-review`.",
				registry,
			});
			return (
				<button type="button" onClick={() => view.render.onOpen("code-review")}>
					open
				</button>
			);
		}

		function LocationProbe() {
			const loc = useLocation();
			return <div data-testid="loc">{loc.pathname}</div>;
		}

		function Harness({ wrapNavigate }: { wrapNavigate: (go: () => void) => void }) {
			return (
				<Routes>
					<Route
						path="/harness/:id/doc"
						element={<TestHarness wrapNavigate={wrapNavigate} />}
					/>
					<Route path="/skill/:name" element={<LocationProbe />} />
				</Routes>
			);
		}

		const { rerender } = renderWithProviders(<Harness wrapNavigate={firstWrap} />, {
			client,
			initialRoute: "/harness/claude-code/doc",
		});

		// Re-render with a fresh `wrapNavigate` — the click below must run this
		// one, not the one captured at mount time.
		rerender(<Harness wrapNavigate={secondWrap} />);

		fireEvent.click(screen.getByText("open"));
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/skill/code-review"));
		expect(secondWrap).toHaveBeenCalledTimes(1);
		expect(firstWrap).not.toHaveBeenCalled();
	});

	it("with host.self absent: mentionedBy is [] even with a populated corpus, and ignored is [] even when the registry holds a refs_ignore for a same-named skill", () => {
		const registryWithIgnore: Registry = {
			...registry,
			skills: {
				...registry.skills,
				// A skill happens to share its name with something that could be
				// mistaken for "self" — irrelevant, since `host.self` is absent.
				"claude-code": {
					version: "1.0.0",
					description: "Not the doc host's identity.",
					source: "~/skill-hub/skills/claude-code",
					type: "claude-skill",
					scope: "global",
					upstream: null,
					managed: "local",
					refs_ignore: ["code-review"],
				},
			},
		};
		const populatedCorpus: SearchCorpus = {
			skills: { orchestrate: "See `code-review` and `claude-code`." },
			snippets: {},
		};
		const client = primeClient({ registry: registryWithIgnore, corpus: populatedCorpus });
		const { result } = renderHook(
			() =>
				useSkillRefs({
					host: { back: baseBack },
					content: "See `code-review` and `claude-code`.",
					registry: registryWithIgnore,
				}),
			{ wrapper: wrapperFor(client) },
		);
		expect(result.current.mentionedBy).toEqual([]);
		expect(result.current.ignored).toEqual([]);
	});
});
