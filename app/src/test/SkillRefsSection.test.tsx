import type { ReactNode } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, fireEvent, renderHook } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
	sampleSourceList,
} from "@/test/helpers";
import { NavigationGuard } from "@/lib/navGuard";
import { qk } from "@/lib/queryKeys";
import { SkillRefsSection } from "@/components/skillEditor/SkillRefsSection";
import { SkillEditorSidePanel } from "@/components/skillEditor/SkillEditorSidePanel";
import { useSkillRefs, type SkillRefsHost } from "@/hooks/useSkillRefs";
import { harnessDocBackTarget, skillBackTarget } from "@/lib/backTarget";
import type { SearchCorpus } from "@/lib/unifiedSearch";
import type { Registry } from "@/types";

// ─── Fixture: an open skill that mentions `code-review` twice and an ignored
// `proof-it`, plus one referrer (`orchestrate`) that mentions it back. ──────
const registry: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"rt-android-expert": {
			...sampleRegistry.skills["rt-android-expert"],
			refs_ignore: ["proof-it"],
		},
		"code-review": {
			version: "1.0.0",
			description: "Review code for correctness and cleanup.",
			source: "~/skill-hub/skills/code-review",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
		"proof-it": {
			version: "1.0.0",
			description: "Screenshot proof for a PR.",
			source: "~/skill-hub/skills/proof-it",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
		orchestrate: {
			version: "1.0.0",
			description: "Ship a goal end to end.",
			source: "~/skill-hub/skills/orchestrate",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
	},
};

const corpus: SearchCorpus = {
	skills: {
		orchestrate: "See `rt-android-expert` for the compose plan.",
	},
	snippets: {},
};

const contentWithMentions =
	"Run `code-review` first, then `code-review` again. Also see `proof-it`.";

const skillHost: SkillRefsHost = {
	self: "rt-android-expert",
	back: skillBackTarget("rt-android-expert"),
};

// A doc host has no `self` — the skill editor's treatment, minus its own
// identity. `harnessDocBackTarget` stands in for any of the four doc hosts;
// the section does not know or care which one it is.
const docHost: SkillRefsHost = {
	back: harnessDocBackTarget("claude-code", "Claude Code"),
};

function primeClient(client: QueryClient, over: { registry?: Registry; corpus?: SearchCorpus } = {}) {
	primeRegistry(client, over.registry ?? registry);
	client.setQueryData(qk.searchCorpus(), over.corpus ?? corpus);
}

function TargetProbe() {
	const location = useLocation();
	return (
		<div>
			<span data-testid="target-path">{location.pathname}</span>
			<span data-testid="target-state">{JSON.stringify(location.state)}</span>
		</div>
	);
}

/** Expand the section only when it is collapsed — it now opens by default
 *  whenever it has entries, so a blind click would close it. */
function ensureOpen(head: HTMLElement) {
	if (head.getAttribute("aria-expanded") === "false") fireEvent.click(head);
}

function renderSection(
	content = contentWithMentions,
	over: { registry?: Registry; corpus?: SearchCorpus; host?: SkillRefsHost; layout?: "section" | "strip" } = {},
) {
	const client = makeQueryClient();
	primeClient(client, over);
	return renderWithProviders(
		<Routes>
			<Route
				path="/skill/:name"
				element={
					<>
						<SkillRefsSection
							host={over.host ?? skillHost}
							content={content}
							registry={over.registry ?? registry}
							layout={over.layout}
						/>
						<TargetProbe />
					</>
				}
			/>
		</Routes>,
		{ client, initialRoute: "/skill/rt-android-expert" },
	);
}

describe("SkillRefsSection", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("lists MENTIONS from the live buffer and MENTIONED BY from the corpus", async () => {
		renderSection();
		const head = await screen.findByTestId("side-section-refs");
		expect(head).toHaveTextContent("References");
		expect(head).toHaveTextContent("2");
		ensureOpen(head);
		const outRow = screen.getByTestId("skill-ref-row-out-code-review");
		expect(outRow).toHaveTextContent("code-review");
		expect(outRow).toHaveTextContent("2×");
		const inRow = screen.getByTestId("skill-ref-row-in-orchestrate");
		expect(inRow).toHaveTextContent("orchestrate");
		expect(inRow).toHaveTextContent("1×");
	});

	it("re-counts MENTIONS when the buffer changes", async () => {
		const client = makeQueryClient();
		primeClient(client);
		const { rerender } = renderWithProviders(
			<Routes>
				<Route
					path="/skill/:name"
					element={
						<SkillRefsSection
							host={skillHost}
							content={contentWithMentions}
							registry={registry}
						/>
					}
				/>
			</Routes>,
			{ client, initialRoute: "/skill/rt-android-expert" },
		);
		const head = await screen.findByTestId("side-section-refs");
		ensureOpen(head);
		expect(screen.getByTestId("skill-ref-row-out-code-review")).toHaveTextContent("2×");

		rerender(
			<Routes>
				<Route
					path="/skill/:name"
					element={
						<SkillRefsSection
							host={skillHost}
							content="`code-review` `code-review` `code-review`"
							registry={registry}
						/>
					}
				/>
			</Routes>,
		);
		expect(screen.getByTestId("skill-ref-row-out-code-review")).toHaveTextContent("3×");
	});

	it("keeps the CodeMirror extension referentially stable across content changes", () => {
		const client = makeQueryClient();
		primeClient(client);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<NavigationGuard>{children}</NavigationGuard>
				</MemoryRouter>
			</QueryClientProvider>
		);
		const { result, rerender } = renderHook(
			({ content }: { content: string }) =>
				useSkillRefs({ host: skillHost, content, registry }),
			{ wrapper, initialProps: { content: "See `code-review`." } },
		);
		const first = result.current.extension;
		const firstRender = result.current.render;
		rerender({ content: "See `code-review` again and again and again." });
		expect(result.current.extension).toBe(first);
		expect(result.current.render).toBe(firstRender);
	});

	it("navigates with the referring skill as the back target", async () => {
		renderSection();
		const head = await screen.findByTestId("side-section-refs");
		ensureOpen(head);
		fireEvent.click(screen.getByTestId("skill-ref-row-out-code-review"));
		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent("/skill/code-review"),
		);
		const state = JSON.parse(screen.getByTestId("target-state").textContent || "null");
		expect(state).toEqual({ from: skillBackTarget("rt-android-expert") });
	});

	it("shows an ignored target as a struck, tagged row", async () => {
		renderSection();
		const head = await screen.findByTestId("side-section-refs");
		ensureOpen(head);
		expect(screen.queryByTestId("skill-ref-row-out-proof-it")).toBeNull();
		const row = screen.getByText("proof-it").closest(".skill-ref-row");
		expect(row).toHaveClass("skill-ref-row-ignored");
		expect(row).toHaveTextContent("ignored");
	});

	it("gives the summary its own wording when the only reference is muted (S5)", async () => {
		renderSection("See `proof-it` only.", { corpus: { skills: {}, snippets: {} } });
		const head = await screen.findByTestId("side-section-refs");
		expect(head).toHaveTextContent("0");
		expect(screen.getByText("1 muted")).toBeInTheDocument();
		ensureOpen(head);
		expect(screen.queryByTestId("skill-ref-row-out-proof-it")).toBeNull();
		const row = screen.getByText("proof-it").closest(".skill-ref-row");
		expect(row).toHaveClass("skill-ref-row-ignored");
	});

	it("renders nothing when there are no refs in either direction", () => {
		const emptyRegistry: Registry = {
			...registry,
			skills: {
				...registry.skills,
				"rt-android-expert": {
					...registry.skills["rt-android-expert"],
					refs_ignore: undefined,
				},
			},
		};
		renderSection("nothing to see here", { registry: emptyRegistry, corpus: { skills: {}, snippets: {} } });
		expect(screen.queryByTestId("side-section-refs")).toBeNull();
	});

	it("sits between USED BY and RUNTIME and starts open when it has entries", async () => {
		const client = makeQueryClient();
		primeClient(client);
		renderWithProviders(
			<SkillEditorSidePanel
				skillName="rt-android-expert"
				skill={registry.skills["rt-android-expert"]}
				registry={registry}
				ownerSource={sampleSourceList.sources[0]}
				installedHarnesses={["claude-code"]}
				busy={false}
				readOnly={false}
				files={<div data-section-id="files">files</div>}
				content={contentWithMentions}
				description="Android compose planner"
				onDescriptionChange={() => {}}
				scope="portable"
				onScopeChange={() => {}}
				version=""
				onVersionChange={() => {}}
				upstream=""
				onUpstreamChange={() => {}}
				affinity={[]}
				onAffinityChange={() => {}}
				onInvocationPick={() => {}}
				invocationBusy={false}
				onDroppedAction={() => {}}
				onOpenPossibleSuccessor={() => {}}
				droppedBusy={false}
			/>,
			{ client },
		);
		await screen.findByTestId("side-section-refs");
		const ids = [...document.querySelectorAll("[data-section-id]")].map((el) =>
			el.getAttribute("data-section-id"),
		);
		expect(ids).toEqual(["files", "usedby", "subagents", "refs", "runtime"]);
		expect(screen.getByTestId("side-section-refs")).toHaveAttribute("aria-expanded", "true");
	});

	it("opens by default when it has entries and names the referenced skills in the summary", async () => {
		renderSection("see `code-review` and `brainstorm` and /needs-global");
		const head = await screen.findByTestId("side-section-refs");
		expect(head).toHaveAttribute("aria-expanded", "true");
		// The summary lives beside the toggle button, not inside it.
		// `needs-global` is not in the primed registry, so two names resolve.
		const summary = document.querySelector(".side-panel-section-summary")?.textContent ?? "";
		expect(summary).toBe("brainstorm, code-review · 1 in");
	});

	// ─── Doc host (F8): `host.self` absent — a harness/snippet/agent-doc/
	// sub-agent editor. One title, no MENTIONED BY, no ignored rows. ─────────

	it("(F8) renders the same title for a doc host, with no MENTIONED BY sub-head and no incoming rows", async () => {
		renderSection(contentWithMentions, { host: docHost, corpus: { skills: {}, snippets: {} } });
		const head = await screen.findByTestId("side-section-refs");
		expect(head).toHaveTextContent("References");
		ensureOpen(head);
		expect(screen.getByTestId("skill-ref-row-out-code-review")).toBeInTheDocument();
		expect(screen.queryByText("Mentioned by")).toBeNull();
		expect(screen.queryByTestId(/^skill-ref-row-in-/)).toBeNull();
		expect(document.querySelector('[data-testid^="skill-ref-row-in-"]')).toBeNull();
	});

	it("(F8) a doc host's summary is names only — no ' · N in' suffix", async () => {
		renderSection("see `code-review` and `brainstorm`", {
			host: docHost,
			corpus: { skills: {}, snippets: {} },
		});
		const head = await screen.findByTestId("side-section-refs");
		const summary = document.querySelector(".side-panel-section-summary")?.textContent ?? "";
		expect(summary).toBe("brainstorm, code-review");
		expect(head).not.toHaveTextContent("in");
	});

	it("a doc host with zero mentions renders nothing", () => {
		renderSection("nothing to see here", { host: docHost, corpus: { skills: {}, snippets: {} } });
		expect(screen.queryByTestId("side-section-refs")).toBeNull();
	});

	it("a doc host's row click navigates with the doc host's own back target", async () => {
		renderSection(contentWithMentions, { host: docHost, corpus: { skills: {}, snippets: {} } });
		const head = await screen.findByTestId("side-section-refs");
		ensureOpen(head);
		fireEvent.click(screen.getByTestId("skill-ref-row-out-code-review"));
		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent("/skill/code-review"),
		);
		const state = JSON.parse(screen.getByTestId("target-state").textContent || "null");
		expect(state).toEqual({ from: harnessDocBackTarget("claude-code", "Claude Code") });
	});

	// ─── layout="strip" (F8) ────────────────────────────────────────────────

	it('(F8) layout="strip" renders the .snip-strip grammar, opens in memory, and writes nothing to localStorage', async () => {
		renderSection(contentWithMentions, {
			host: docHost,
			corpus: { skills: {}, snippets: {} },
			layout: "strip",
		});
		const strip = await screen.findByTestId("agent-docs-refs-strip");
		expect(strip).toHaveClass("snip-strip");
		expect(strip.querySelector(".snip-strip-head")).toBeInTheDocument();
		const toggle = screen.getByTestId("agent-docs-refs-toggle");
		expect(toggle).toHaveClass("snip-strip-toggle");
		expect(toggle.querySelector(".snip-strip-title")).toHaveTextContent("References");
		expect(toggle.querySelector(".snip-strip-count")).toHaveTextContent("2");
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(strip.querySelector(".snip-strip-body")).toBeInTheDocument();
		expect(strip.querySelector(".equip-group")).toBeNull();
		expect(document.querySelector('[class="equip-group"]')).toBeNull();

		const lenBefore = window.localStorage.length;
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(strip.querySelector(".snip-strip-body")).toBeNull();
		expect(window.localStorage.length).toBe(lenBefore);

		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(window.localStorage.length).toBe(lenBefore);
	});

	it('layout="strip" is absent when there are no mentions', () => {
		renderSection("nothing to see here", {
			host: docHost,
			corpus: { skills: {}, snippets: {} },
			layout: "strip",
		});
		expect(screen.queryByTestId("agent-docs-refs-strip")).toBeNull();
	});
});
