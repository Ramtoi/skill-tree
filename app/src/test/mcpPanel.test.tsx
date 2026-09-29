import { it, expect, vi, beforeEach } from "vitest";
import { focusManager } from "@tanstack/react-query";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
	renderWithProviders,
	sampleRegistry,
	primeRegistry,
	makeQueryClient,
	mockSyncReport,
} from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { buildArgvArgs } from "@/hooks/useMcpDraft";
import type { Registry, Skill } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const CONTEXT7: Skill = {
	version: "1.0.0",
	description: "Hosted docs MCP server",
	source: "~/skill-hub/mcp-servers/context7",
	type: "mcp-server",
	scope: "portable",
	upstream: null,
	managed: "local",
	mcp: {
		transport: "http",
		url: "https://mcp.context7.com/mcp",
		headers: {
			Authorization: "Bearer sk-live-abcdefgh12345678",
			Accept: "application/json",
			"X-Region": "${REGION}",
		},
	},
};

const STDIO_SRV: Skill = {
	version: "1.0.0",
	description: "A stdio server",
	source: "~/skill-hub/mcp-servers/stdio-srv",
	type: "mcp-server",
	scope: "portable",
	upstream: null,
	managed: "local",
	mcp: { command: "python3", args: ["server.py"] },
};

const STDIO_ENV_SRV: Skill = {
	version: "1.0.0",
	description: "A stdio server with environment variables",
	source: "~/skill-hub/mcp-servers/stdio-env-srv",
	type: "mcp-server",
	scope: "portable",
	upstream: null,
	managed: "local",
	mcp: { command: "python3", args: ["server.py"], env: { DEBUG: "1", API_TOKEN: "sk-live-abcdefgh12345678" } },
};

const READONLY_MCP: Skill = {
	version: "0.4.0",
	description: "External MCP server",
	source: "~/skill-hub/sources/design-system/worktree/skills/ds-tokens-mcp",
	type: "mcp-server",
	scope: "portable",
	upstream: "git@github.com:acme/design-system.git",
	managed: "external",
	origin: { source: "design-system", source_type: "git", path: "skills/ds-tokens-mcp", ref: "abc" },
	mcp: { command: "python3", args: ["server.py"] },
};

function registryWith(extra: Record<string, Skill>): Registry {
	return { ...sampleRegistry, skills: { ...sampleRegistry.skills, ...extra } };
}

function baseEnvelope(overrides: Partial<SyncReportEnvelope["report"]> = {}): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-06T00:00:00Z",
			registry_sha256: "sha1",
			registry_mtime: 0,
			ok: true,
			global: { skipped: [], skills: { writes: 0, removed: 0 }, mcp: { writes: 0, removed: 0 }, permissions: { ok: true, errors: [] }, remotes: { attempted: 0, alarming: 0 } },
			projects: {},
			...overrides,
		},
		registry_current: { sha256: "sha1", mtime: 0 },
	};
}

interface InvokeConfig {
	filesListing?: { root: string; files: unknown[]; truncated: boolean };
	checkResponse?: () => Promise<{ success: boolean; output: string }>;
	setResponse?: (cmdArgs: string[]) => { success: boolean; output: string };
	setJsonResponse?: (args: string[], body: string) => unknown;
	showLastProbe?: unknown;
}

function installInvoke(cfg: InvokeConfig = {}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "check_python") return true;
		if (cmd === "read_skill_document") {
			const { name } = (args as { name: string }) ?? { name: "" };
			return { name, description: "", body: `# ${name}` };
		}
		if (cmd === "skill_files_list") {
			return cfg.filesListing ?? { root: "", files: [], truncated: false };
		}
		if (cmd === "hub_cmd") {
			const cmdArgs = ((args as { args?: string[] })?.args) ?? [];
			if (cmdArgs[0] === "mcp" && cmdArgs[1] === "show") {
				return {
					success: true,
					output: JSON.stringify({
						ok: true,
						name: cmdArgs[2],
						scope: "portable",
						description: "",
						harnesses: null,
						spec: {},
						secret_refs: [],
						literal_secret_keys: [],
						equipped: { projects: [], bundles: [], remotes: [], cloud: [] },
						resolved: [],
						last_probe: cfg.showLastProbe ?? null,
					}),
				};
			}
			if (cmdArgs[0] === "mcp" && cmdArgs[1] === "check") {
				if (cfg.checkResponse) return cfg.checkResponse();
				return {
					success: true,
					output: JSON.stringify({
						name: cmdArgs[2],
						transport: "http",
						state: "ok",
						tool_count: 2,
						tools: ["search", "fetch"],
						latency_ms: 100,
						protocol_version: "2024-11-05",
						unresolved_refs: [],
						env_from_shell: true,
						error: null,
						checked_at: "2026-09-06T00:00:00Z",
						ok: true,
					}),
				};
			}
			if (cmdArgs[0] === "mcp" && cmdArgs[1] === "set") {
				if (cfg.setResponse) return cfg.setResponse(cmdArgs);
				return {
					success: true,
					output: JSON.stringify({ ok: true, name: cmdArgs[2], spec: {}, changed_keys: [], warnings: [], prior_spec: {} }),
				};
			}
			return { success: true, output: "{}" };
		}
		if (cmd === "mcp_set_json") {
			if (cfg.setJsonResponse) {
				const a = (args as { args?: string[] })?.args ?? [];
				const b = (args as { body?: string })?.body ?? "{}";
				return cfg.setJsonResponse(a, b);
			}
			return { ok: true, name: "context7", spec: {}, changed_keys: [], warnings: [], prior_spec: {} };
		}
		return undefined;
	}) as never);
}

function renderEditor(route: string, registry: Registry, envelope?: SyncReportEnvelope | null) {
	const client = makeQueryClient();
	primeRegistry(client, registry);
	if (envelope !== undefined) mockSyncReport(envelope);
	return renderWithProviders(
		<>
			<Routes>
				<Route path="/skill/:name" element={<SkillEditor />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: route },
	);
}

beforeEach(() => {
	queryClient.clear();
	useAppStore.setState({ toasts: [] });
	installInvoke();
});

// Case 8
it("renders the panel instead of a code editor for an mcp-server", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	expect(document.querySelector(".cm-editor")).toBeNull();
});

// Case 9 (negative control)
it("renders the markdown editor for a claude-skill", async () => {
	renderEditor("/skill/brainstorm", sampleRegistry, baseEnvelope());
	await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
	expect(screen.queryByTestId("mcp-panel")).toBeNull();
});

// Case 10 (F2)
it("hides FILES for a server whose folder holds only SKILL.md", async () => {
	installInvoke({ filesListing: { root: "", files: [], truncated: false } });
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	expect(screen.queryByTestId(/side-section-files/)).toBeNull();
});

// Case 11 (F2)
it("shows FILES for a scaffolded stdio server and issues the files query", async () => {
	installInvoke({
		filesListing: {
			root: "/Users/dev/mcp-servers/stdio-srv",
			files: [
				{ rel: "SKILL.md", size: 10, kind: "markdown", editable: true, reason: null },
				{ rel: "server.py", size: 20, kind: "script", editable: true, reason: null },
			],
			truncated: false,
		},
	});
	renderEditor("/skill/stdio-srv", registryWith({ "stdio-srv": STDIO_SRV }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith("skill_files_list", { name: "stdio-srv" }),
	);
	await waitFor(() => expect(screen.getByText("server.py")).toBeInTheDocument());
});

// Case 12
it("shows a reference chip for a ${VAR} header and masks a literal one", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	expect(screen.getByText("${REGION}")).toBeInTheDocument();
	// The literal value string must be absent from the DOM entirely, not just
	// visually hidden.
	expect(document.body.innerHTML).not.toContain("sk-live-abcdefgh12345678");
	expect(screen.getByDisplayValue("••••••••")).toBeInTheDocument();
});

// Case 13 (m5)
it("replace-with-reference keeps the Bearer scheme and marks the panel dirty", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	fireEvent.click(screen.getByText("Use a ${…} reference"));
	await waitFor(() => expect(screen.getByText("${CONTEXT7_TOKEN}")).toBeInTheDocument());
	expect(document.querySelector(".btn-signal-dot")).not.toBeNull();
});

// Case 14 (M8)
it("⌘S with a changed header submits through mcp_set_json with the body on stdin", async () => {
	installInvoke({
		setJsonResponse: (_args, body) => ({
			ok: true,
			name: "context7",
			spec: JSON.parse(body),
			changed_keys: ["headers"],
			warnings: [],
			prior_spec: CONTEXT7.mcp,
		}),
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	fireEvent.change(screen.getByLabelText("Accept value"), { target: { value: "text/plain" } });
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"mcp_set_json",
			expect.objectContaining({ args: expect.any(Array), body: expect.any(String) }),
		),
	);
	const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_set_json");
	const argsJson = JSON.stringify((call?.[1] as { args: string[] }).args);
	expect(argsJson).not.toContain("Bearer");
	expect(argsJson).not.toContain("sk-live-abcdefgh12345678");
});

// Case 15
it("⌘S with only a url change uses the plain hub_cmd path", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
		target: { value: "https://mcp.context7.com/mcp/v2" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
			args: ["mcp", "set", "context7", "--url", "https://mcp.context7.com/mcp/v2", "--json"],
		}),
	);
});

// Case 16
it("save failure keeps the draft dirty and toasts", async () => {
	installInvoke({ setResponse: () => ({ success: false, output: "boom" }) });
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
		target: { value: "https://mcp.context7.com/broken" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() => expect(screen.getByText("Couldn't update the server")).toBeInTheDocument());
	expect(document.querySelector(".btn-signal-dot")).not.toBeNull();
});

// Case 17 (m14)
it("undo re-submits the whole prior spec", async () => {
	const priorSpec = {
		transport: "http",
		command: "python3",
		args: ["server.py"],
		url: "https://mcp.context7.com/mcp",
		headers: { Authorization: "Bearer ${CONTEXT7_TOKEN}" },
	};
	installInvoke({
		setJsonResponse: (_args, body) => ({
			ok: true,
			name: "context7",
			spec: JSON.parse(body),
			changed_keys: ["headers"],
			warnings: [],
			prior_spec: priorSpec,
		}),
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	fireEvent.change(screen.getByLabelText("Accept value"), { target: { value: "text/plain" } });
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() => expect(screen.getByText("Server updated")).toBeInTheDocument());
	fireEvent.click(screen.getByText("Undo"));
	await waitFor(() => {
		const calls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "mcp_set_json");
		expect(calls.length).toBeGreaterThanOrEqual(2);
	});
	const calls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "mcp_set_json");
	const undoBody = JSON.parse((calls[calls.length - 1][1] as { body: string }).body);
	expect(undoBody).toMatchObject({
		transport: "http",
		command: "python3",
		args: ["server.py"],
		url: "https://mcp.context7.com/mcp",
	});
	expect(undoBody.headers).toBeTruthy();
});

// Case 18
it("delivery rows render one row per (harness, scope) with the right badge", async () => {
	const envelope = baseEnvelope({
		global: {
			skipped: [],
			skills: { writes: 0, removed: 0 },
			mcp: {
				writes: 0,
				removed: 0,
				delivery: [
					{ harness: "claude-code", adapter: "claude", scope: "global", server: "context7", target_file: "/Users/dev/.claude.json", state: "written", reason: null, detail: null },
					{ harness: "opencode", adapter: "", scope: "global", server: "context7", target_file: "", state: "skipped", reason: "no_global_target", detail: null },
				],
			},
			permissions: { ok: true, errors: [] },
			remotes: { attempted: 0, alarming: 0 },
		},
		projects: {},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), envelope);
	await waitFor(() => expect(screen.getAllByTestId("mcp-delivery-row")).toHaveLength(2));
	expect(screen.getByText("Delivered")).toBeInTheDocument();
	expect(screen.getByText("Skipped")).toBeInTheDocument();
});

// Case 19 (F3)
it("a blocked row renders its reason copy, including a detail", async () => {
	const envelope = baseEnvelope({
		global: {
			skipped: [],
			skills: { writes: 0, removed: 0 },
			mcp: {
				writes: 0,
				removed: 0,
				delivery: [
					{ harness: "codex", adapter: "codex", scope: "global", server: "context7", target_file: "/Users/dev/.codex/config.toml", state: "blocked", reason: "codex_header_not_representable", detail: "X-Trace" },
				],
			},
			permissions: { ok: true, errors: [] },
			remotes: { attempted: 0, alarming: 0 },
		},
		projects: {},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), envelope);
	await waitFor(() => expect(screen.getByText("Blocked")).toBeInTheDocument());
	expect(
		screen.getByText("Codex cannot express the X-Trace header as a reference. It was left out."),
	).toBeInTheDocument();
});

// Case 20 (m2)
it("a codex_no_sse row renders as Skipped, not Blocked", async () => {
	const envelope = baseEnvelope({
		global: {
			skipped: [],
			skills: { writes: 0, removed: 0 },
			mcp: {
				writes: 0,
				removed: 0,
				delivery: [
					{ harness: "codex", adapter: "codex", scope: "global", server: "context7", target_file: "", state: "skipped", reason: "codex_no_sse", detail: null },
				],
			},
			permissions: { ok: true, errors: [] },
			remotes: { attempted: 0, alarming: 0 },
		},
		projects: {},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), envelope);
	await waitFor(() => expect(screen.getByText("Skipped")).toBeInTheDocument());
	expect(screen.queryByText("Blocked")).toBeNull();
});

// Case 21
it("empty delivery renders the Not-synced-yet empty state with a Sync now action", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByText("Not synced yet")).toBeInTheDocument());
	expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
});

// Case 22
it("the Check button does not probe on mount", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByText("Never checked.")).toBeInTheDocument());
	const checkCalls = vi
		.mocked(invoke)
		.mock.calls.filter(
			([cmd, args]) =>
				cmd === "hub_cmd" && ((args as { args?: string[] })?.args ?? [])[1] === "check",
		);
	expect(checkCalls).toHaveLength(0);
});

// Case 23
it("clicking Check invokes hub mcp check once and renders the ok line", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-check-button")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("mcp-check-button"));
	await waitFor(() => expect(screen.getByText(/Answered/)).toBeInTheDocument());
	const checkCalls = vi
		.mocked(invoke)
		.mock.calls.filter(
			([cmd, args]) =>
				cmd === "hub_cmd" && ((args as { args?: string[] })?.args ?? [])[1] === "check",
		);
	expect(checkCalls).toHaveLength(1);
});

// G-fix — the user reported (2026-09-07) that a 47-tool server showed its count
// buried mid-line beside the latency, with no way to reach the tools. DELIVERY
// now answers liveness only and CAPABILITIES owns every count: `probe.tool_count`
// is one un-paginated `tools/list`, so it disagrees with the catalogue on any
// paginating server and the two must never appear on screen together.
it("the ok line answers liveness only — no tool count, latency demoted below it", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-check-button")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("mcp-check-button"));

	const okLine = await screen.findByText(/Answered/);
	expect(okLine).toHaveTextContent(/^Answered$/);
	// Neither the count nor the latency may ride along in the emphasised line.
	expect(okLine).not.toHaveTextContent(/tool/);
	expect(okLine).not.toHaveTextContent("100 ms");
	expect(okLine).toHaveAttribute("data-emphasis", "count");

	// The latency lives in the quiet context line, with the freshness.
	const contextLine = okLine.nextElementSibling;
	expect(contextLine).toHaveClass("mcp-probe-detail");
	expect(contextLine).toHaveTextContent("100 ms");
	expect(contextLine).toHaveTextContent(/checked/);
});

// G-fix — the contradiction this guards against: the probe fixture reports 2
// tools from its single `tools/list`, the catalogue fixture a different number.
// Exactly one of them may reach the screen.
it("the panel prints a tool count in one place only", async () => {
	// The live Check probe (installInvoke's default `mcp check`) reports 2
	// tools; give CAPABILITIES a cached catalogue reporting a DIFFERENT count
	// (5) so the two numbers genuinely disagree, same as the G-fix's guard —
	// without this, `showLastProbe` defaults to null, CAPABILITIES never
	// prints a count at all, and the match count is trivially 0.
	installInvoke({
		showLastProbe: {
			name: "context7",
			transport: "http",
			state: "ok",
			tool_count: 5,
			tools: ["a", "b", "c", "d", "e"],
			latency_ms: 80,
			protocol_version: "2024-11-05",
			unresolved_refs: [],
			env_from_shell: true,
			error: null,
			checked_at: "2026-09-06T00:00:00Z",
			catalog: {
				tools: 5,
				resources: 0,
				resource_templates: 0,
				prompts: 0,
				offered: { tools: true, resources: false, resource_templates: false, prompts: false },
				unknown: [],
				server_name: null,
				server_version: null,
				instructions: false,
				errors: 0,
			},
		},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-check-button")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("mcp-check-button"));
	await screen.findByText(/Answered/);
	await screen.findByText(/5 tools/);

	const panel = screen.getByTestId("mcp-panel");
	// No trailing `\b`: adjacent elements (e.g. the CAPABILITIES "Browse…"
	// button right after its count line) render with no separating text
	// node, so "5 tools" and "Browse…" concatenate to "5 toolsBrowse…" in
	// `textContent` with no word boundary after "tools".
	const counts = (panel.textContent ?? "").match(/\d+ tools?/g) ?? [];
	expect(counts.length).toBe(1);
});

// G-fix — a non-`ok` state returns a full sentence, not a count, so it must not
// take the larger type (`[data-emphasis="count"]` in mcp-panel.css).
it("a non-ok probe line is not emphasised as a count", async () => {
	installInvoke({
		checkResponse: async () => ({
			success: true,
			output: JSON.stringify({
				name: "context7",
				transport: "http",
				state: "unreachable",
				tool_count: null,
				tools: [],
				latency_ms: null,
				protocol_version: null,
				unresolved_refs: [],
				env_from_shell: true,
				error: "connection refused",
				checked_at: "2026-09-06T00:00:00Z",
				ok: false,
			}),
		}),
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-check-button")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("mcp-check-button"));
	const line = await screen.findByText(/Could not reach the server/);
	expect(line).not.toHaveAttribute("data-emphasis");
});

// Case 24 (M5)
it("an unresolved_ref probe renders the info line naming the shell, and env_from_shell:false adds the GUI line", async () => {
	installInvoke({
		checkResponse: async () => ({
			success: true,
			output: JSON.stringify({
				name: "context7",
				transport: "http",
				state: "unresolved_ref",
				tool_count: null,
				tools: [],
				latency_ms: null,
				protocol_version: null,
				unresolved_refs: ["MY_TOKEN"],
				env_from_shell: false,
				error: null,
				checked_at: "2026-09-06T00:00:00Z",
				ok: false,
			}),
		}),
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-check-button")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("mcp-check-button"));
	await waitFor(() =>
		expect(screen.getByText(/MY_TOKEN.*not set in your shell environment/)).toBeInTheDocument(),
	);
	expect(
		screen.getByText(/could not read your login shell/),
	).toBeInTheDocument();
});

// Case 25 (m13)
it("a cached probe renders the Last checked line without probing", async () => {
	installInvoke({
		showLastProbe: {
			name: "context7",
			transport: "http",
			state: "ok",
			tool_count: 3,
			tools: ["a", "b", "c"],
			latency_ms: 250,
			protocol_version: "2024-11-05",
			unresolved_refs: [],
			env_from_shell: true,
			error: null,
			checked_at: "2026-09-05T00:00:00Z",
		},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByText(/checked/)).toBeInTheDocument());
	const checkCalls = vi
		.mocked(invoke)
		.mock.calls.filter(
			([cmd, args]) =>
				cmd === "hub_cmd" && ((args as { args?: string[] })?.args ?? [])[1] === "check",
		);
	expect(checkCalls).toHaveLength(0);
});

// Case 26
it("switching transport stdio→http preserves the command in the draft", async () => {
	renderEditor("/skill/stdio-srv", registryWith({ "stdio-srv": STDIO_SRV }), baseEnvelope());
	await waitFor(() => expect(screen.getByDisplayValue("python3")).toBeInTheDocument());
	fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
	await waitFor(() => expect(screen.getByText(/kept until you save/)).toBeInTheDocument());
	fireEvent.click(screen.getByRole("radio", { name: "Local (stdio)" }));
	await waitFor(() => expect(screen.getByDisplayValue("python3")).toBeInTheDocument());
});

// Case 27
it("a read-only (external-source) server renders the panel without inputs", async () => {
	renderEditor("/skill/ds-tokens-mcp", registryWith({ "ds-tokens-mcp": READONLY_MCP }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	const panel = screen.getByTestId("mcp-panel");
	expect(within(panel).queryByRole("textbox")).toBeNull();
});

// Case 28 (m7)
it("the panel root is focusable", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	expect(screen.getByTestId("mcp-panel")).toHaveAttribute("tabIndex", "-1");
});

// ─── Wave E1b review fixes ──────────────────────────────────────────────────

// C1 — a bare `--arg -y` makes argparse treat `-y` as a flag of its own.
// `buildArgvArgs` is defensive belt-and-braces: `args` itself now always
// routes through stdin once changed (C4), so this path is unreachable in the
// live UI flow today, but it must still be correct in isolation.
it("buildArgvArgs (C1) uses --arg=VALUE so a dash-led argument never confuses argparse", () => {
	const argv = buildArgvArgs("fs-mcp", ["args"], { args: ["-y", "@scope/pkg"] });
	expect(argv).toEqual(["mcp", "set", "fs-mcp", "--arg=-y", "--arg=@scope/pkg", "--json"]);
});

// C1/C4 — the live UI flow: editing a dash-led argument and saving never
// touches argv at all (C4 routes any `args` change through stdin), which is
// the actual fix a user experiences.
it("editing arguments to dash-led values routes the save through stdin, never argv", async () => {
	renderEditor("/skill/stdio-srv", registryWith({ "stdio-srv": STDIO_SRV }), baseEnvelope());
	await waitFor(() => expect(screen.getByDisplayValue("server.py")).toBeInTheDocument());
	fireEvent.change(screen.getByDisplayValue("server.py"), { target: { value: "-y" } });
	fireEvent.click(screen.getByText("Add argument"));
	const argInputs = document.querySelectorAll<HTMLInputElement>(".mcp-arg-row input");
	expect(argInputs).toHaveLength(2);
	fireEvent.change(argInputs[1], { target: { value: "@scope/pkg" } });
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"mcp_set_json",
			expect.objectContaining({ args: expect.any(Array), body: expect.any(String) }),
		),
	);
	const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_set_json");
	const body = JSON.parse((call?.[1] as { body: string }).body);
	expect(body.args).toEqual(["-y", "@scope/pkg"]);
	const setViaArgv = vi
		.mocked(invoke)
		.mock.calls.find(
			([cmd, a]) => cmd === "hub_cmd" && ((a as { args?: string[] })?.args ?? [])[1] === "set",
		);
	expect(setViaArgv).toBeUndefined();
});

// C2 — a credential in the endpoint URL's query string must never reach argv
// either; `literalSecretKeysOf` already flags a `url.query:<key>` token for
// exactly this shape.
it("a credential in the URL query string routes through stdin, never argv", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-panel")).toBeInTheDocument());
	fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
		target: { value: "https://mcp.context7.com/mcp?api_key=sk-live-abcdefgh12345678" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"mcp_set_json",
			expect.objectContaining({ args: expect.any(Array), body: expect.any(String) }),
		),
	);
	for (const [cmd, args] of vi.mocked(invoke).mock.calls) {
		if (cmd === "hub_cmd") {
			expect(JSON.stringify(args)).not.toContain("sk-live-abcdefgh12345678");
		}
	}
});

// C3 — once armed, a window refocus must not silently re-probe.
it("a window refocus after Check does not re-probe", async () => {
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByTestId("mcp-check-button")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("mcp-check-button"));
	await waitFor(() => expect(screen.getByText(/Answered/)).toBeInTheDocument());

	const checkCallsBefore = vi
		.mocked(invoke)
		.mock.calls.filter(
			([cmd, args]) => cmd === "hub_cmd" && ((args as { args?: string[] })?.args ?? [])[1] === "check",
		).length;

	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	focusManager.setFocused(undefined);

	const checkCallsAfter = vi
		.mocked(invoke)
		.mock.calls.filter(
			([cmd, args]) => cmd === "hub_cmd" && ((args as { args?: string[] })?.args ?? [])[1] === "check",
		).length;
	expect(checkCallsAfter).toBe(checkCallsBefore);
	expect(checkCallsAfter).toBe(1);
});

// C4 — header removal patches only the removed key, as `null` (INTERFACES
// §3: "a null value inside a nested dict of the hub mcp set --json-stdin
// body DELETES that key"). The mock's response simulates the (parallel,
// Python-side D3) CLI fix by simply omitting the removed key from `spec`.
it("removing a header pins a {key: null} stdin patch and the row disappears", async () => {
	installInvoke({
		setJsonResponse: (_args, body) => {
			const patch = JSON.parse(body);
			const headers = { ...CONTEXT7.mcp!.headers, ...patch.headers };
			for (const [k, v] of Object.entries(headers)) if (v === null) delete headers[k];
			return {
				ok: true,
				name: "context7",
				spec: { ...CONTEXT7.mcp, headers },
				changed_keys: ["headers"],
				warnings: [],
				prior_spec: CONTEXT7.mcp,
			};
		},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), baseEnvelope());
	await waitFor(() => expect(screen.getByLabelText("Accept value")).toBeInTheDocument());
	fireEvent.click(screen.getByRole("button", { name: "Remove Accept" }));
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"mcp_set_json",
			expect.objectContaining({ args: expect.any(Array), body: expect.any(String) }),
		),
	);
	const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_set_json");
	const body = JSON.parse((call?.[1] as { body: string }).body);
	expect(body.headers).toEqual({ Accept: null });
	await waitFor(() => expect(screen.queryByLabelText("Accept value")).toBeNull());
});

// C4 — same shape for an env var on a stdio server.
it("removing an env var pins a {key: null} stdin patch and the row disappears", async () => {
	installInvoke({
		setJsonResponse: (_args, body) => {
			const patch = JSON.parse(body);
			const env = { ...STDIO_ENV_SRV.mcp!.env, ...patch.env };
			for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
			return {
				ok: true,
				name: "stdio-env-srv",
				spec: { ...STDIO_ENV_SRV.mcp, env },
				changed_keys: ["env"],
				warnings: [],
				prior_spec: STDIO_ENV_SRV.mcp,
			};
		},
	});
	renderEditor(
		"/skill/stdio-env-srv",
		registryWith({ "stdio-env-srv": STDIO_ENV_SRV }),
		baseEnvelope(),
	);
	await waitFor(() => expect(screen.getByLabelText("DEBUG value")).toBeInTheDocument());
	fireEvent.click(screen.getByRole("button", { name: "Remove DEBUG" }));
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"mcp_set_json",
			expect.objectContaining({ args: expect.any(Array), body: expect.any(String) }),
		),
	);
	const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_set_json");
	const body = JSON.parse((call?.[1] as { body: string }).body);
	expect(body.env).toEqual({ DEBUG: null });
	await waitFor(() => expect(screen.queryByLabelText("DEBUG value")).toBeNull());
});

// C4 — clearing arguments to zero replaces the whole list over stdin (a list
// value REPLACES wholesale, per the same INTERFACES §3 sentence).
it("clearing every argument pins {args: []} over stdin", async () => {
	renderEditor("/skill/stdio-srv", registryWith({ "stdio-srv": STDIO_SRV }), baseEnvelope());
	await waitFor(() => expect(screen.getByDisplayValue("server.py")).toBeInTheDocument());
	fireEvent.click(screen.getByRole("button", { name: "Remove argument 1" }));
	fireEvent.click(screen.getByRole("button", { name: /^Save ⌘S$/ }));
	await waitFor(() =>
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"mcp_set_json",
			expect.objectContaining({ args: expect.any(Array), body: expect.any(String) }),
		),
	);
	const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_set_json");
	const body = JSON.parse((call?.[1] as { body: string }).body);
	expect(body.args).toEqual([]);
});

// W1 — an unrecognized delivery state renders a neutral badge naming itself
// instead of throwing on the STATE_BADGE lookup.
it("an unrecognized delivery state degrades to a neutral badge instead of throwing", async () => {
	const envelope = baseEnvelope({
		global: {
			skipped: [],
			skills: { writes: 0, removed: 0 },
			mcp: {
				writes: 0,
				removed: 0,
				delivery: [
					{
						harness: "codex",
						adapter: "codex",
						scope: "global",
						server: "context7",
						target_file: "",
						// A word this build's STATE_BADGE map does not know.
						state: "quarantined" as never,
						reason: null,
						detail: null,
					},
				],
			},
			permissions: { ok: true, errors: [] },
			remotes: { attempted: 0, alarming: 0 },
		},
		projects: {},
	});
	renderEditor("/skill/context7", registryWith({ context7: CONTEXT7 }), envelope);
	await waitFor(() => expect(screen.getByText("quarantined")).toBeInTheDocument());
});
