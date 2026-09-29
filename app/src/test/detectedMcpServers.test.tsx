import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DetectedMcpServers } from "@/components/mcp/DetectedMcpServers";
import { McpCompareSheet } from "@/components/mcp/McpCompareSheet";
import { useMcpDecisions } from "@/hooks/useMcpDecisions";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import type { McpCandidate, McpCandidateOption, McpUnsupportedReason } from "@/lib/mcpContract";

// ─── plans/E2.md §5 `detectedMcpServers.test.tsx` — cases 17-25 ─────────────

function newCand(overrides: Partial<McpCandidate> = {}): McpCandidate {
	return {
		name: "weather-api",
		status: "new",
		spec: { transport: "http", url: "https://weather.example.com/mcp" },
		sources: [
			{ harness: "claude-code", file: "~/.claude.json", scope: "user", name: "weather-api", native: {} },
		],
		options: [],
		reason: null,
		warnings: [],
		import_name: "weather-api",
		...overrides,
	};
}

function conflictCand(overrides: Partial<McpCandidate> = {}): McpCandidate {
	return {
		name: "context7",
		status: "conflict",
		spec: null,
		sources: [
			{
				harness: "claude-code",
				scope: "user",
				file: "~/.claude.json",
				name: "context7",
				native: {},
			},
			{
				// N6: Codex has no "user" scope — its config discovers as
				// "global" (grill finding 5); a fixture that keeps "user" here
				// pins the exact wording grill 5 said was wrong.
				harness: "codex",
				scope: "global",
				file: "~/.codex/config.toml",
				name: "context7",
				native: {},
			},
		],
		options: [
			{
				harness: "claude-code",
				scope: "user",
				file: "~/.claude.json",
				spec: { transport: "http", url: "https://mcp.context7.com/mcp" },
			},
			{
				harness: "codex",
				scope: "global",
				file: "~/.codex/config.toml",
				spec: { transport: "http", url: "https://mcp.context7.com/v2/mcp" },
			},
		],
		reason: null,
		warnings: [],
		import_name: "context7",
		...overrides,
	};
}

function unsupportedCand(reason: McpUnsupportedReason | string, name = "figma-mcp"): McpCandidate {
	return {
		name,
		status: "unsupported",
		spec: null,
		sources: [],
		options: [],
		reason,
		warnings: [],
		import_name: reason.startsWith("invalid_name") ? null : name,
	};
}

/** Renders the REAL `useMcpDecisions()` hook (not a hand-rolled stand-in) so
 *  every case here exercises the actual `adoptMcp`/`keepMcp`/`compareAdoptMcp`
 *  code — the wire contract (the pinned decision object), the toast copy
 *  (W1), and the visible "the row disappears" effect a real invalidate+
 *  refetch produces. Needs `<ToastContainer />` alongside it (toasts read
 *  from the zustand store directly, no provider required) so toast-copy
 *  assertions can see the rendered result. The screen-level integration
 *  (this hook actually living in `SkillLibrary`, wired to the real
 *  `useMcpCandidates` query) is covered by the e2e journey (case 26). */
function Harness({ initial, onCompare }: { initial: McpCandidate[]; onCompare?: (c: McpCandidate) => void }) {
	const [candidates, setCandidates] = useState(initial);
	const { adoptMcp, keepMcp } = useMcpDecisions();

	async function wrap(cand: McpCandidate, fn: (c: McpCandidate) => Promise<void>) {
		try {
			await fn(cand);
			setCandidates((cur) => cur.filter((c) => c.name !== cand.name));
		} catch {
			/* the hook's own toast already reports it; nothing else to do here */
		}
	}

	return (
		<>
			<DetectedMcpServers
				candidates={candidates}
				onAdopt={(c) => wrap(c, (x) => adoptMcp(x))}
				onAdoptAsRef={(c) => wrap(c, (x) => adoptMcp(x, { replaceWithRef: true }))}
				onAdoptAnyway={(c) => wrap(c, (x) => adoptMcp(x, { allowLiteral: true }))}
				onKeep={(c) => wrap(c, (x) => keepMcp(x))}
				onCompare={onCompare ?? (() => {})}
			/>
			<ToastContainer />
		</>
	);
}

function defaultApplyResult() {
	return {
		ok: true,
		imported: [],
		kept: [],
		unkept: [],
		skipped: [],
		conflicts_resolved: 0,
		synced: true,
		suggested_refs: [],
		renamed: [] as { from: string; to: string }[],
		claimed: [] as { harness: string; scope: string; file: string }[],
		removed_native: [] as { harness: string; scope: string; file: string }[],
		errors: [] as string[],
	};
}

beforeEach(() => {
	useAppStore.setState({ toasts: [] });
	vi.mocked(invoke).mockImplementation((async () => defaultApplyResult()) as never);
	try {
		window.localStorage.clear();
	} catch {
		/* noop */
	}
});

describe("DetectedMcpServers", () => {
	it("17. no band when there are no new or conflict candidates (M9)", () => {
		render(<Harness initial={[unsupportedCand("oauth_block"), conflictCand({ status: "already_managed" as never })]} />);
		expect(screen.queryByTestId("detected-mcp-servers")).toBeNull();
	});

	it("18a. a new candidate renders NEW + Adopt + Keep native with the source line", () => {
		render(<Harness initial={[newCand()]} />);
		expect(screen.getByText("NEW")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Adopt" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Keep native" })).toBeInTheDocument();
		expect(screen.getByText(/found in Claude Code/)).toBeInTheDocument();
	});

	it("18b. a Claude local-scope source adds 'local scope' (M7)", () => {
		render(
			<Harness
				initial={[
					newCand({
						sources: [
							{
								harness: "claude-code",
								file: "~/proj/.claude.json",
								scope: "local",
								name: "weather-api",
								native: {},
							},
						],
					}),
				]}
			/>,
		);
		expect(screen.getByText(/local scope/)).toBeInTheDocument();
	});

	it("19. Adopt pipes one import decision through mcp_reconcile_apply", async () => {
		render(<Harness initial={[newCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: { decisions: [{ name: "weather-api", action: "import" }] },
				}),
			),
		);
		await waitFor(() => expect(screen.queryByText("weather-api")).not.toBeInTheDocument());
	});

	function literalCand() {
		return newCand({
			name: "linear-mcp",
			spec: { transport: "http", url: "https://mcp.linear.app/sse" },
			warnings: ["literal_secret:Authorization"],
		});
	}

	it("20a. a literal-carrying candidate renders LITERAL, names the key only, and Adopt as ${…} pins replace_with_ref", async () => {
		render(<Harness initial={[literalCand()]} />);
		expect(screen.getByText("LITERAL")).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("sk-live-");
		const adoptAsRef = screen.getByRole("button", { name: /Adopt as \$\{/ });
		expect(adoptAsRef.textContent).toContain("LINEAR_MCP_TOKEN");
		fireEvent.click(adoptAsRef);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: {
						decisions: [{ name: "linear-mcp", action: "import", replace_with_ref: true }],
					},
				}),
			),
		);
		await waitFor(() => expect(screen.queryByText("linear-mcp")).not.toBeInTheDocument());
	});

	it("20b. Adopt anyway pins allow_literal on a separate candidate", async () => {
		render(<Harness initial={[literalCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt anyway" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: {
						decisions: [{ name: "linear-mcp", action: "import", allow_literal: true }],
					},
				}),
			),
		);
		await waitFor(() => expect(screen.queryByText("linear-mcp")).not.toBeInTheDocument());
	});

	it("20c. a url-embedded token (literal_secret:url.query:token) never renders the token, and the key is split correctly (W5)", () => {
		const cand = newCand({
			name: "search-mcp",
			spec: { transport: "http", url: "https://search.example.com/mcp?token=sk-live-abcdefgh12345678" },
			warnings: ["literal_secret:url.query:token"],
		});
		render(<Harness initial={[cand]} />);
		expect(screen.getByText("LITERAL")).toBeInTheDocument();
		// The raw `url.query:token` token never reaches the DOM — only the bare
		// param name, via `bareKeyOf` — and the value never does either.
		expect(document.body.textContent).not.toContain("sk-live-");
		expect(document.body.textContent).not.toContain("url.query:token");
		expect(screen.getByText(/token carries a token in plain text/)).toBeInTheDocument();
		const adoptAsRef = screen.getByRole("button", { name: /Adopt as \$\{/ });
		expect(adoptAsRef.textContent).toContain("SEARCH_MCP_TOKEN");
	});

	it("21. Keep native pipes one keep decision and the row disappears (M9)", async () => {
		render(<Harness initial={[newCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Keep native" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: { decisions: [{ name: "weather-api", action: "keep" }] },
				}),
			),
		);
		await waitFor(() => expect(screen.queryByText("weather-api")).not.toBeInTheDocument());
	});

	it("21b. a non-empty errors[] shows a warning, not a success — and names the count + the sync gap (W1)", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			...defaultApplyResult(),
			imported: ["weather-api"],
			synced: false,
			errors: ["weather-api: cannot update ~/.codex/config.toml: tomlkit not installed"],
		})) as never);
		render(<Harness initial={[newCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
		expect(await screen.findByText(/Adopted weather-api with 1 problem/)).toBeInTheDocument();
		expect(screen.queryByText("Adopted weather-api")).not.toBeInTheDocument();
		expect(screen.getByText(/tomlkit not installed/)).toBeInTheDocument();
		expect(screen.getByText(/has not synced to your native config files yet/)).toBeInTheDocument();
		// A partial failure is still reported through the SAME channel used for
		// a hard failure (`toast.error`), never the green success path.
		expect(document.querySelector(".toast-success")).not.toBeInTheDocument();
	});

	it("21c. a hard failure says nothing changed (W1)", async () => {
		vi.mocked(invoke).mockImplementation((async () => {
			throw new Error("hub exited non-zero");
		}) as never);
		render(<Harness initial={[newCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
		expect(await screen.findByText(/Nothing was changed\./)).toBeInTheDocument();
		// A hard failure never removes the row — the registry rolled back.
		expect(screen.getByText("weather-api")).toBeInTheDocument();
	});

	const REASON_LINES: Partial<Record<McpUnsupportedReason, RegExp>> = {
		ws_transport: /WebSocket servers are Claude Code only/,
		oauth_block: /signs in through the harness/,
		headers_helper: /gets its headers from a script/,
		unknown_shape: /does not recognise this entry/,
		local_scope_unregistered_project: /folder Skill Tree does not track/,
		no_global_target: /no user-level MCP file for this harness/,
	};

	it("22. unsupported candidates fold into one dim line, collapsed by default, and expand to their reason copy", () => {
		const reasons = Object.keys(REASON_LINES) as McpUnsupportedReason[];
		render(
			<Harness
				initial={[
					newCand(),
					...reasons.map((r, i) => unsupportedCand(r, `unsupported-${i}`)),
				]}
			/>,
		);
		const toggle = screen.getByRole("button", { name: /stay native \(why\)/ });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		for (const r of reasons) {
			expect(screen.queryByText(REASON_LINES[r]!)).not.toBeInTheDocument();
		}
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		for (const r of reasons) {
			expect(screen.getByText(REASON_LINES[r]!)).toBeInTheDocument();
		}
	});

	/** Renders the band + the REAL compare sheet, wired through the REAL
	 *  `useMcpDecisions().compareAdoptMcp` (not a hand-rolled stand-in) so the
	 *  harness+scope (and, for 23b, `file`) actually travel through the
	 *  production decision-building code, not just the test's own guess at
	 *  its shape. */
	function CompareRoot({
		cand,
		scopeKind,
	}: {
		cand: McpCandidate;
		/** W3: the reconcile scope `adoptionConsequences` computes its lines
		 *  against — defaults to "global" (today's only wired-up caller). */
		scopeKind?: "global" | "project";
	}) {
		const [openSheet, setOpenSheet] = useState(false);
		const [candidates] = useState([cand]);
		const { compareAdoptMcp } = useMcpDecisions();
		async function adoptOne(
			c: McpCandidate,
			option: (typeof c.options)[number],
			opts?: { allowLiteral?: boolean; replaceWithRef?: boolean },
		) {
			await compareAdoptMcp(c, option, opts);
			setOpenSheet(false);
		}
		return (
			<>
				<DetectedMcpServers
					candidates={candidates}
					onAdopt={async () => {}}
					onAdoptAsRef={async () => {}}
					onAdoptAnyway={async () => {}}
					onKeep={async () => {}}
					onCompare={() => setOpenSheet(true)}
				/>
				<McpCompareSheet
					open={openSheet}
					onClose={() => setOpenSheet(false)}
					candidate={openSheet ? cand : null}
					onAdopt={adoptOne}
					scopeKind={scopeKind}
				/>
				<ToastContainer />
			</>
		);
	}

	it("23a. a conflict candidate renders DIFFERS + Compare… and no Adopt; Compare… opens the sheet and Adopt this one pipes a harness-qualified decision", async () => {
		const cand = conflictCand();
		render(<CompareRoot cand={cand} />);
		expect(screen.getByText("DIFFERS")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		expect(await screen.findByText("context7 · configured in 2 places")).toBeInTheDocument();
		const options = screen.getAllByTestId("mcp-compare-option");
		expect(options).toHaveLength(2);
		fireEvent.click(within(options[1]).getByRole("button", { name: "Adopt this one" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: {
						decisions: [
						{
							name: "context7",
							action: "import",
							harness: "codex",
							scope: "global",
							file: "~/.codex/config.toml",
						},
					],
					},
				}),
			),
		);
	});

	it("23b. two options sharing (harness, scope) each pin their OWN file (W2)", async () => {
		const cand = conflictCand({
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { transport: "http", url: "https://mcp.context7.com/mcp" },
				},
				{
					harness: "claude-code",
					scope: "user",
					file: "/Users/dev/projects/example-app/.claude.json",
					spec: { transport: "http", url: "https://mcp.context7.com/v2/mcp" },
				},
			],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		expect(options).toHaveLength(2);
		fireEvent.click(within(options[1]).getByRole("button", { name: "Adopt this one" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: {
						decisions: [
							{
								name: "context7",
								action: "import",
								harness: "claude-code",
								scope: "user",
								file: "/Users/dev/projects/example-app/.claude.json",
							},
						],
					},
				}),
			),
		);
	});

	it("24. an unclaimed_native_entry conflict renders its own line (F5)", () => {
		render(<Harness initial={[conflictCand({ warnings: ["unclaimed_native_entry"] })]} />);
		expect(
			screen.getByText("Skill Tree has this server but did not write the copy on disk."),
		).toBeInTheDocument();
	});

	// ─── E3 rev 2 §5 case 18/19 — global scope, the registry pseudo-option, literal actions ─

	it("case 18: a global-scope option card reads 'Codex · global', never a dangling separator", async () => {
		const cand = conflictCand({
			sources: [
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", name: "context7", native: {} },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", name: "context7", native: {} },
			],
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { transport: "http", url: "https://mcp.context7.com/mcp" },
				},
				{
					harness: "codex",
					scope: "global",
					file: "~/.codex/config.toml",
					spec: { transport: "http", url: "https://mcp.context7.com/v2/mcp" },
				},
			],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		expect(await screen.findByText("Codex · global")).toBeInTheDocument();
	});

	it("case 18b: the F5 registry pseudo-option reads \"Skill Tree's own record\" with no path row", async () => {
		const cand = conflictCand({
			options: [
				...conflictCand().options,
				{ harness: "registry", scope: null, file: null, spec: { transport: "http", url: "https://mcp.context7.com/mcp" } },
			],
			warnings: ["unclaimed_native_entry"],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		expect(await screen.findByText("Skill Tree's own record")).toBeInTheDocument();
		const options = screen.getAllByTestId("mcp-compare-option");
		const registryCard = options[options.length - 1];
		expect(within(registryCard).queryByText(/\.claude\.json|config\.toml/)).not.toBeInTheDocument();
	});

	it("case 19a: a literal conflict shows 'Adopt as ${VAR}' + 'Adopt anyway' per card, and each pins the right decision fields", async () => {
		const cand = conflictCand({ warnings: ["literal_secret:Authorization"] });
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		expect(options).toHaveLength(2);
		const primary = within(options[0]).getByRole("button", { name: /Adopt as \$\{/ });
		expect(primary.textContent).toContain("CONTEXT7_TOKEN");
		fireEvent.click(primary);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: {
						decisions: [
							{
								name: "context7",
								action: "import",
								harness: "claude-code",
								scope: "user",
								file: "~/.claude.json",
								replace_with_ref: true,
							},
						],
					},
				}),
			),
		);
	});

	it("case 19b: the ghost button pins allow_literal on the OTHER card", async () => {
		const cand = conflictCand({ warnings: ["literal_secret:Authorization"] });
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		fireEvent.click(within(options[1]).getByRole("button", { name: "Adopt anyway" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: {
						decisions: [
							{
								name: "context7",
								action: "import",
								harness: "codex",
								scope: "global",
								file: "~/.codex/config.toml",
								allow_literal: true,
							},
						],
					},
				}),
			),
		);
	});

	it("case 19c: a url.userinfo warning key resolves through bareKeyOf and shows Adopt anyway only", async () => {
		const cand = conflictCand({ warnings: ["literal_secret:url.userinfo"] });
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		for (const option of options) {
			expect(within(option).queryByRole("button", { name: /Adopt as \$\{/ })).not.toBeInTheDocument();
			expect(within(option).getByRole("button", { name: "Adopt anyway" })).toBeInTheDocument();
		}
	});

	it("case 19c-2: a url.userinfo credential never reaches the DOM in the compare sheet (F4)", async () => {
		const cand = conflictCand({
			warnings: ["literal_secret:url.userinfo"],
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { transport: "http", url: "https://user:s3cr3t-pw@mcp.context7.com/mcp" },
				},
				{
					harness: "codex",
					scope: "user",
					file: "~/.codex/config.toml",
					spec: { transport: "http", url: "https://mcp.context7.com/v2/mcp" },
				},
			],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		await screen.findAllByTestId("mcp-compare-option");
		expect(document.body.textContent).not.toContain("user:s3cr3t-pw");
		expect(document.body.textContent).not.toContain("s3cr3t-pw");
	});

	it("case 19d: a non-literal conflict keeps a single 'Adopt this one' per card and shows the consequence line", async () => {
		const cand = conflictCand();
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		for (const option of options) {
			expect(within(option).getByRole("button", { name: "Adopt this one" })).toBeInTheDocument();
		}
		// At global scope every OTHER copy is "Updates" (E3 rev 2 §2.3) —
		// adopting the claude-code card names codex as the update target.
		expect(within(options[0]).getByText(/Updates: Codex/)).toBeInTheDocument();
	});

	// ─── W3 — adoptionConsequences' scope rule, wired end-to-end through the
	// real sheet: a project-scope reconcile Removes a Claude LOCAL copy even
	// when it is the one being adopted (the review's bug #1).

	it("W3: at PROJECT scope a Claude local copy shows 'Removes' even on its OWN card", async () => {
		const cand = conflictCand({
			sources: [
				{ harness: "claude-code", scope: "local", file: "~/proj/.claude.json", name: "context7", native: {} },
				{ harness: "codex", scope: "project", file: "~/proj/.codex/config.toml", name: "context7", native: {} },
			],
			options: [
				{
					harness: "claude-code",
					scope: "local",
					file: "~/proj/.claude.json",
					spec: { transport: "http", url: "https://mcp.context7.com/mcp" },
				},
				{
					harness: "codex",
					scope: "project",
					file: "~/proj/.codex/config.toml",
					spec: { transport: "http", url: "https://mcp.context7.com/v2/mcp" },
				},
			],
		});
		render(<CompareRoot cand={cand} scopeKind="project" />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		// The FIRST card (Claude Code · local) is itself the local copy —
		// its own consequence line still reads "Removes", never silently
		// excluded because it happens to be the one with the button on it.
		expect(within(options[0]).getByText("Removes: Claude Code (local)")).toBeInTheDocument();
		expect(within(options[1]).getByText("Removes: Claude Code (local)")).toBeInTheDocument();
	});

	// ─── W9 — a RENAMED conflict candidate (the mock's own "Sanity" → "sanity"
	// naming, `renamed_from:Sanity`, two DIFFERING native copies so it is
	// genuinely a `conflict`, not a `new` row) must say "Removes" on EVERY
	// card BEFORE the click, and the toast after the click must say the same
	// thing — never "Updates" where the apply actually deletes the entry.

	it("W9: a renamed conflict candidate shows 'Removes' on every card, and the toast agrees after the click", async () => {
		const cand = conflictCand({
			name: "sanity",
			import_name: "sanity",
			sources: [
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", name: "Sanity", native: {} },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", name: "sanity", native: {} },
			],
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { command: "npx", args: ["sanity-a"] },
				},
				{
					harness: "codex",
					scope: "global",
					file: "~/.codex/config.toml",
					spec: { command: "npx", args: ["sanity-b"] },
				},
			],
			warnings: ["renamed_from:Sanity"],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const options = await screen.findAllByTestId("mcp-compare-option");
		// The PRE-CLICK promise: every card, including the one whose OWN
		// button is on it, reads "Removes" for BOTH native sources — a rename
		// removes everything, it does not pick a winner to "Update".
		for (const option of options) {
			expect(within(option).getByText("Removes: Claude Code (user)")).toBeInTheDocument();
			expect(within(option).getByText("Removes: Codex (global)")).toBeInTheDocument();
			expect(within(option).queryByText(/^Updates:/)).not.toBeInTheDocument();
		}
		// The POST-CLICK report: the mock's real rename behaviour (W6) removes
		// every native source and reports `renamed` — the toast must name the
		// SAME two places the cards just promised, not a different set.
		vi.mocked(invoke).mockImplementation((async () => ({
			...defaultApplyResult(),
			renamed: [{ from: "Sanity", to: "sanity" }],
			removed_native: [
				{ harness: "claude-code", scope: "user", file: "~/.claude.json" },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml" },
			],
		})) as never);
		// `options[1]` (Codex · global) is the source whose OWN native key
		// already equals the resolved slug, so its button reads "Adopt this
		// one" rather than "Adopt as sanity" (`optionRenamedTo`) — either
		// card's click sends the same rename decision.
		fireEvent.click(within(options[1]).getByRole("button", { name: "Adopt this one" }));
		expect(await screen.findByText("Adopted Sanity as sanity.")).toBeInTheDocument();
		expect(
			await screen.findByText(/Removed the Claude Code \(user\) copy\./),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Removed the Codex \(global\) copy\./),
		).toBeInTheDocument();
	});

	// ─── W1 — after redaction two options can be byte-identical; say so
	// instead of marking a difference nobody can see.

	it("W1: two copies that differ ONLY in a credential render one explanatory line, not a phantom diff mark", async () => {
		const cand = conflictCand({
			name: "creds-mcp",
			sources: [
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", name: "creds-mcp", native: {} },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", name: "creds-mcp", native: {} },
			],
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { transport: "http", url: "https://user:pw@mcp.example.com" },
				},
				{
					harness: "codex",
					scope: "global",
					file: "~/.codex/config.toml",
					spec: { transport: "http", url: "https://mcp.example.com" },
				},
			],
			warnings: ["literal_secret:url.userinfo"],
			import_name: "creds-mcp",
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		await screen.findAllByTestId("mcp-compare-option");
		expect(
			screen.getByText("The two copies differ only in a credential value."),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("user:pw");
	});

	// ─── W8 — the "differ only in a credential" line must NOT render for an
	// invisible difference that isn't one: stdio, same command, same ENV
	// KEYS (headers/env compare by key set only, S1), no `literal_secret:*`
	// warning anywhere — a value-only `env.FOO` difference the sheet cannot
	// show, but not a credential.

	it("W8: an env-VALUE-only conflict with no literal-secret warning gets the honest non-credential line", async () => {
		const cand = conflictCand({
			name: "stdio-mcp",
			sources: [
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", name: "stdio-mcp", native: {} },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", name: "stdio-mcp", native: {} },
			],
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { transport: "stdio", command: "npx", args: ["run"], env: { FOO: "a" } },
				},
				{
					harness: "codex",
					scope: "global",
					file: "~/.codex/config.toml",
					spec: { transport: "stdio", command: "npx", args: ["run"], env: { FOO: "b" } },
				},
			],
			warnings: [],
			import_name: "stdio-mcp",
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		await screen.findAllByTestId("mcp-compare-option");
		expect(
			screen.getByText("These copies differ only in a value Skill Tree does not show."),
		).toBeInTheDocument();
		expect(screen.queryByText("The two copies differ only in a credential value.")).not.toBeInTheDocument();
	});

	// ─── W2 — the sheet says what "Adopt anyway" costs, same as the band.

	it("W2: the sheet renders the userinfo reason line above the option grid", async () => {
		const cand = conflictCand({ warnings: ["literal_secret:url.userinfo"] });
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		await screen.findAllByTestId("mcp-compare-option");
		// The BAND (rendered alongside the sheet in this harness) shows its
		// own copy of this exact line — scope to the dialog so the sheet's
		// own W2 fix is what is actually under test.
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("The URL carries a username and password.")).toBeInTheDocument();
	});

	it("W2: the sheet renders the non-userinfo literal reason line above the option grid", async () => {
		const cand = conflictCand({ warnings: ["literal_secret:Authorization"] });
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		await screen.findAllByTestId("mcp-compare-option");
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByText("Authorization carries a token in plain text."),
		).toBeInTheDocument();
	});

	// ─── N4 — "Adopt anyway" is ghost everywhere (§2.4).

	it("N4: the sheet's 'Adopt anyway' (both the literal and the userinfo branch) renders ghost", async () => {
		const userinfoCand = conflictCand({ warnings: ["literal_secret:url.userinfo"] });
		const { unmount } = render(<CompareRoot cand={userinfoCand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const userinfoOptions = await screen.findAllByTestId("mcp-compare-option");
		for (const option of userinfoOptions) {
			expect(within(option).getByRole("button", { name: "Adopt anyway" }).className).toContain(
				"btn-ghost",
			);
		}
		unmount();

		const literalCand = conflictCand({ warnings: ["literal_secret:Authorization"] });
		render(<CompareRoot cand={literalCand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		const literalOptions = await screen.findAllByTestId("mcp-compare-option");
		for (const option of literalOptions) {
			expect(within(option).getByRole("button", { name: "Adopt anyway" }).className).toContain(
				"btn-ghost",
			);
		}
	});

	// ─── W7 — a url.query:<param> literal masks through bareKeyOf, and every
	// such warning masks (not just the first).

	it("W7: a url.query:token conflict resolves through bareKeyOf, masking WITHOUT percent-encoding", async () => {
		const cand = conflictCand({
			options: [
				{
					harness: "claude-code",
					scope: "user",
					file: "~/.claude.json",
					spec: { transport: "http", url: "https://search.example.com/mcp?token=sk-live-abcdefgh12345678" },
				},
				{
					harness: "codex",
					scope: "global",
					file: "~/.codex/config.toml",
					spec: { transport: "http", url: "https://search.example.com/v2/mcp?token=sk-live-abcdefgh12345678" },
				},
			],
			warnings: ["literal_secret:url.query:token"],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		await screen.findAllByTestId("mcp-compare-option");
		expect(document.body.textContent).not.toContain("sk-live-");
		expect(document.body.textContent).not.toContain("url.query:token");
		expect(document.body.textContent).not.toContain("%E2%80%A2");
		// The band shows the same reason line for its own row — scope to the
		// dialog so this pins the SHEET's copy specifically (W2).
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("token carries a token in plain text.")).toBeInTheDocument();
		expect(within(dialog).getAllByText(/token=••••••/).length).toBeGreaterThan(0);
	});

	// ─── N1 — an unrecognized scope word degrades instead of crashing.

	it("N1: an unrecognized scope word renders itself rather than 'undefined'", async () => {
		const cand = conflictCand({
			options: [
				...conflictCand().options,
				{
					harness: "codex",
					// A differently-versioned `hub` this build does not know
					// about yet — deliberately outside the `McpScope` union.
					scope: "a-scope-no-wave-has-shipped",
					file: "~/somewhere/config.toml",
					spec: { transport: "http", url: "https://mcp.context7.com/v3/mcp" },
				} as unknown as McpCandidateOption,
			],
		});
		render(<CompareRoot cand={cand} />);
		fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
		expect(await screen.findByText("Codex · a-scope-no-wave-has-shipped")).toBeInTheDocument();
	});

	it("25a. an already_managed candidate never renders", () => {
		render(<Harness initial={[newCand(), newCand({ name: "already-one", status: "already_managed" })]} />);
		expect(screen.queryByText("already-one")).not.toBeInTheDocument();
	});

	it("25b. a stale candidate never renders", () => {
		render(<Harness initial={[newCand(), newCand({ name: "stale-one", status: "stale" })]} />);
		expect(screen.queryByText("stale-one")).not.toBeInTheDocument();
	});

	// ─── E3 rev 2 §5 case 20 — the Sanity row, place-naming, warnings, name_taken ─

	function sanityCand(overrides: Partial<McpCandidate> = {}): McpCandidate {
		return newCand({
			name: "sanity",
			import_name: "sanity",
			sources: [{ harness: "claude-code", file: "~/.claude.json", scope: "user", name: "Sanity", native: {} }],
			warnings: ["renamed_from:Sanity"],
			...overrides,
		});
	}

	it("case 20a: a renamed new row's button reads 'Adopt as sanity' and the decision carries as: sanity", async () => {
		render(<Harness initial={[sanityCand()]} />);
		const button = screen.getByRole("button", { name: "Adopt as sanity" });
		fireEvent.click(button);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_reconcile_apply",
				expect.objectContaining({
					decisions: { decisions: [{ name: "sanity", action: "import", as: "sanity" }] },
				}),
			),
		);
	});

	it("case 20b: a renamed + literal row keeps the ${VAR} chip and adds a 'registered as' dim line", () => {
		render(
			<Harness
				initial={[
					sanityCand({
						warnings: ["renamed_from:Sanity", "literal_secret:Authorization"],
					}),
				]}
			/>,
		);
		const adoptAsRef = screen.getByRole("button", { name: /Adopt as \$\{/ });
		expect(adoptAsRef.textContent).toContain("SANITY_TOKEN");
		// N10: the identifier itself renders in mono, split into its own
		// element — match on the line's full text, not a single text node.
		const registeredAs = screen.getByText((_, el) => el?.textContent === "registered as sanity");
		expect(registeredAs).toBeInTheDocument();
		expect(within(registeredAs).getByText("sanity")).toHaveStyle({ fontFamily: "var(--font-mono)" });
	});

	it("case 20c: a url.userinfo literal shows only Adopt anyway and a different reason line", () => {
		render(
			<Harness
				initial={[
					newCand({
						name: "creds-mcp",
						spec: { transport: "http", url: "https://user:pw@example.com/mcp" },
						warnings: ["literal_secret:url.userinfo"],
					}),
				]}
			/>,
		);
		expect(screen.getByText("LITERAL")).toBeInTheDocument();
		expect(screen.getByText("The URL carries a username and password.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Adopt as \$\{/ })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Adopt anyway" })).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("user:pw");
	});

	it("case 20d: a conflict row's place-naming line names the actual harness+scope pairs", () => {
		render(<Harness initial={[conflictCand()]} />);
		expect(
			screen.getByText("Claude Code (user) and Codex (global) configure this differently."),
		).toBeInTheDocument();
	});

	it("case 20e: a row's non-literal, non-rename warning renders as a dim line", () => {
		render(<Harness initial={[newCand({ warnings: ["command_has_arguments"] })]} />);
		expect(
			screen.getByText("The command contains spaces; hub does not split it."),
		).toBeInTheDocument();
	});

	it("case 20f: a name_taken row renders its reason line (once expanded) and no Adopt button anywhere", () => {
		render(<Harness initial={[newCand(), unsupportedCand("name_taken:unslop", "unslop")]} />);
		expect(screen.queryByRole("button", { name: "Adopt" })).toBeInTheDocument(); // the OTHER row's button
		expect(screen.queryByText("unslop")).not.toBeInTheDocument(); // folded, not expanded yet
		fireEvent.click(screen.getByRole("button", { name: /stay native \(why\)/ }));
		expect(
			screen.getByText(/unslop is already a different skill in your registry\./),
		).toBeInTheDocument();
		// No row anywhere offers an Adopt affordance for it — the fold has none.
		expect(screen.queryByRole("button", { name: "Adopt as unslop" })).not.toBeInTheDocument();
	});

	// ─── E3 rev 2 §5 case 21 — toasts (renamed / removed_native / failure / undo) ─

	it("case 21a: a renamed import's success toast reads 'Adopted Sanity as sanity.'", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			...defaultApplyResult(),
			renamed: [{ from: "Sanity", to: "sanity" }],
		})) as never);
		render(<Harness initial={[sanityCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt as sanity" }));
		expect(await screen.findByText("Adopted Sanity as sanity.")).toBeInTheDocument();
	});

	it("case 21b: removed_native adds the removed-copy sentence to the toast body", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			...defaultApplyResult(),
			removed_native: [{ harness: "claude-code", scope: "local", file: "~/proj/.claude.json" }],
		})) as never);
		render(<Harness initial={[newCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
		expect(
			await screen.findByText(/Removed the Claude Code \(local\) copy\./),
		).toBeInTheDocument();
	});

	it("case 21c: a structured ok:false failure reads the CLI's error, then 'Nothing was changed.'", async () => {
		vi.mocked(invoke).mockImplementation((async () => ({
			ok: false,
			error: "a credential is written as plain text",
			code: "literal_secret",
		})) as never);
		render(<Harness initial={[newCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
		expect(
			await screen.findByText(/a credential is written as plain text/),
		).toBeInTheDocument();
		expect(screen.getByText(/Nothing was changed\./)).toBeInTheDocument();
	});

	it("case 21d: Undo archives the resolved slug (sanity), never the raw native key (Sanity)", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "hub_cmd") return { success: true, output: "" };
			return { ...defaultApplyResult(), renamed: [{ from: "Sanity", to: "sanity" }] };
		}) as never);
		render(<Harness initial={[sanityCand()]} />);
		fireEvent.click(screen.getByRole("button", { name: "Adopt as sanity" }));
		const undo = await screen.findByRole("button", { name: "Undo" });
		fireEvent.click(undo);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({ args: ["archive", "sanity"] }),
			),
		);
	});
});
