import { it, expect, vi } from "vitest";
import { act } from "@testing-library/react";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient } from "./helpers";
import { qk } from "@/lib/queryKeys";
import { McpCapabilitiesBlock } from "@/components/mcp/McpCapabilitiesBlock";
import { McpCapabilitySheet } from "@/components/mcp/McpCapabilitySheet";
import type { McpCatalog, McpCatalogSummary } from "@/lib/mcpContract";

// `McpCapabilitySheet` (props `name, open, onClose`) and
// `McpCapabilitiesBlock` (props `name`) have no vitest importer today — every
// behavior here replaces a step of `app/e2e/mcp-panel.journey.spec.ts`
// (plan row `mcp-panel`, unit A4 item 1). The vitest test drives the same
// mock responses (`hub mcp show`/`hub mcp catalog`) through `vi.mocked(invoke)`
// instead of a real browser.

const OFFERED_ALL = { tools: true, resources: true, resource_templates: true, prompts: true };

function catalogSummary(overrides: Partial<McpCatalogSummary> = {}): McpCatalogSummary {
	return {
		tools: 44,
		resources: 3,
		resource_templates: 1,
		prompts: 2,
		offered: OFFERED_ALL,
		unknown: [],
		server_name: "context7",
		server_version: "2.4.0",
		instructions: true,
		errors: 0,
		...overrides,
	};
}

const GET_PAGE_TOOL: McpCatalog["tools"][number] = {
	name: "get_page",
	title: "Get Page",
	description: "Fetch one documentation page by id.",
	parameters: [
		{
			name: "id",
			type: "string",
			required: true,
			description: "The page id.",
			enum: null,
			enum_truncated: false,
			default: null,
			items_type: null,
		},
		{
			name: "format",
			type: "string",
			required: false,
			description: "Output format.",
			enum: ["json", "markdown", "text"],
			enum_truncated: false,
			default: "markdown",
			items_type: null,
		},
	],
	schema_unreadable: false,
	parameters_truncated: false,
	annotations: { read_only: true, destructive: null, idempotent: null, open_world: null },
};

const CREATE_PAGE_TOOL: McpCatalog["tools"][number] = {
	name: "create_page",
	title: null,
	description: "Create a new documentation page.",
	parameters: [
		{
			name: "title",
			type: "string",
			required: true,
			description: "The page title.",
			enum: null,
			enum_truncated: false,
			default: null,
			items_type: null,
		},
	],
	schema_unreadable: false,
	parameters_truncated: false,
	annotations: null,
	output_parameters: [
		{
			name: "url",
			type: "string",
			required: false,
			description: "The page's canonical URL.",
			enum: null,
			enum_truncated: false,
			default: null,
			items_type: null,
		},
	],
	output_schema_present: true,
	output_schema_unreadable: false,
};

const LEGACY_TOOL: McpCatalog["tools"][number] = {
	name: "legacy_tool",
	title: null,
	description: "A tool whose schema this server does not expose in a readable shape.",
	parameters: [],
	schema_unreadable: true,
	parameters_truncated: false,
	annotations: null,
};

function catalogRecord(tools: McpCatalog["tools"], overrides: Partial<McpCatalog> = {}): McpCatalog {
	return {
		schema_version: 1,
		name: "context7",
		fetched_at: "2026-09-06T12:00:00Z",
		transport: "http",
		protocol_version: "2025-06-18",
		server_name: "context7",
		server_version: "2.4.0",
		instructions: "Use search_docs to find a page, then get_page to fetch it in full.",
		capabilities: ["tools", "resources", "prompts"],
		offered: { tools: true, resources: false, resource_templates: false, prompts: false },
		tools,
		resources: [],
		resource_templates: [],
		prompts: [],
		truncated: { tools: false, resources: false, resource_templates: false, prompts: false },
		bytes_truncated: false,
		fetch_errors: [],
		...overrides,
	};
}

/** Installs `hub_cmd` responses for `mcp show` (per-call `lastProbe` via a
 *  getter, so a test can flip the "before check" → "after check" state) and
 *  `mcp catalog` (a fixed record). Every other command falls through to
 *  setup.ts's default. */
function installMcp(opts: {
	lastProbe?: () => Record<string, unknown> | null;
	catalog?: McpCatalog | { ok: false; error: string; code: "no_catalog" };
}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
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
						last_probe: opts.lastProbe ? opts.lastProbe() : null,
					}),
				};
			}
			if (cmdArgs[0] === "mcp" && cmdArgs[1] === "catalog") {
				const payload = opts.catalog
					? "ok" in opts.catalog
						? opts.catalog
						: { ok: true, catalog: opts.catalog }
					: { ok: false, error: "no stored catalogue", code: "no_catalog" };
				return { success: true, output: JSON.stringify(payload) };
			}
		}
		return undefined;
	}) as never);
}

// Journey: "MCP capabilities: honest empty state before a Check, real counts
// after" (mcp-panel.journey.spec.ts ~:97).
it("MCP capabilities: honest empty state before a Check, real counts after", async () => {
	const client = makeQueryClient();
	let checked = false;
	installMcp({
		lastProbe: () =>
			checked
				? {
						name: "context7",
						transport: "http",
						state: "ok",
						tool_count: 4,
						tools: ["search_docs", "get_page", "list_versions", "resolve_ref"],
						latency_ms: 187,
						protocol_version: "2024-11-05",
						unresolved_refs: [],
						env_from_shell: true,
						error: null,
						checked_at: "2026-09-06T12:00:00Z",
						catalog: catalogSummary(),
					}
				: null,
	});

	renderWithProviders(<McpCapabilitiesBlock name="context7" />, { client });

	await screen.findByText(
		"Not checked yet. Check the connection above to read what this server offers.",
	);
	expect(screen.queryByTestId("mcp-capabilities-browse")).not.toBeInTheDocument();

	// Simulate a completed Check (owned by the sibling DELIVERY block): it
	// invalidates the same `qk.mcpShow` key this block reads (design G.md
	// §6.4), which is exactly what a real `hub mcp check` click triggers.
	checked = true;
	await act(async () => {
		await client.invalidateQueries({ queryKey: qk.mcpShow("context7") });
	});

	await screen.findByText(/44 tools/);
	expect(screen.getByTestId("mcp-capabilities-browse")).toBeVisible();
});

// Journey: "MCP capability sheet: browse a tool, read its parameters and a
// declared annotation chip" (mcp-panel.journey.spec.ts ~:112).
it("MCP capability sheet: browse a tool, read its parameters and a declared annotation chip", async () => {
	installMcp({ catalog: catalogRecord([GET_PAGE_TOOL, CREATE_PAGE_TOOL]) });

	renderWithProviders(<McpCapabilitySheet name="context7" open onClose={() => {}} />);

	// The title ("Get Page") is the primary rail label; the wire name is a
	// secondary suffix, never hidden (rev 3 §11.4).
	const rows = await screen.findAllByTestId("mcp-sheet-row");
	const getPageRow = rows.find((r) => within(r).queryByText("Get Page"));
	expect(getPageRow).toBeTruthy();
	fireEvent.click(getPageRow!);

	const detail = await screen.findByTestId("mcp-sheet-tool-detail");
	expect(within(detail).getByText(/get_page/)).toBeVisible();

	const params = within(detail).getByTestId("mcp-parameters-table");
	expect(params).toHaveTextContent("id");
	expect(params).toHaveTextContent("required");
	expect(params).toHaveTextContent("format");
	expect(params).toHaveTextContent("markdown");

	// A server-declared annotation renders as a neutral Chip carrying the
	// "untrusted hint" title — never a RiskBadge (rev 3 §11.6).
	const chip = within(detail).getByText("read-only");
	expect(chip).toBeVisible();
	expect(chip.closest(".chip")).toHaveAttribute("title", expect.stringMatching(/does not verify/));
});

// Journey: "MCP capability sheet: a tool with an outputSchema shows a
// collapsed RETURNS table that a summary expands" (mcp-panel.journey.spec.ts
// ~:138).
it("MCP capability sheet: a tool with an outputSchema shows a collapsed RETURNS table that a summary expands", async () => {
	installMcp({ catalog: catalogRecord([GET_PAGE_TOOL, CREATE_PAGE_TOOL]) });

	renderWithProviders(<McpCapabilitySheet name="context7" open onClose={() => {}} />);

	const rows = await screen.findAllByTestId("mcp-sheet-row");
	const createPageRow = rows.find((r) => within(r).queryByText("create_page"));
	expect(createPageRow).toBeTruthy();
	fireEvent.click(createPageRow!);

	const detail = await screen.findByTestId("mcp-sheet-tool-detail");
	const returnsDetails = within(detail).getByText("RETURNS").closest("details");
	expect(returnsDetails).toBeTruthy();
	// Collapsed by default so it never competes with the input parameters.
	// jsdom applies no UA stylesheet, so a closed <details>'s children stay in
	// the accessibility tree either way (TESTS.md §6: no layout in jsdom) —
	// the real, testable signal is the element's own `open` state, which is
	// what a real browser's CSS collapse is driven by.
	expect((returnsDetails as HTMLDetailsElement).open).toBe(false);
	const returnsTable = within(returnsDetails as HTMLElement).getByTestId("mcp-parameters-table");
	expect(returnsTable).toHaveTextContent("url");

	fireEvent.click(within(returnsDetails as HTMLElement).getByText("RETURNS"));

	await waitFor(() => expect((returnsDetails as HTMLDetailsElement).open).toBe(true));
});

// Journey: "MCP capability sheet: an unreadable schema says so, never a
// lying empty parameter list" (mcp-panel.journey.spec.ts ~:155).
it("MCP capability sheet: an unreadable schema says so and never shows an empty parameter list", async () => {
	installMcp({ catalog: catalogRecord([LEGACY_TOOL], { offered: { tools: true, resources: false, resource_templates: false, prompts: false } }) });

	renderWithProviders(<McpCapabilitySheet name="context7" open onClose={() => {}} />);

	const row = await screen.findByTestId("mcp-sheet-row");
	fireEvent.click(row);

	await screen.findByText("This tool declares no readable parameters.");
	expect(screen.queryByTestId("mcp-parameters-table")).not.toBeInTheDocument();
});

// Journey: "MCP capability sheet: ArrowDown selects rows, / returns focus to
// search" (mcp-panel.journey.spec.ts ~:164).
it("MCP capability sheet: ArrowDown selects rows and / returns focus to search", async () => {
	installMcp({ catalog: catalogRecord([LEGACY_TOOL], { offered: { tools: true, resources: false, resource_templates: false, prompts: false } }) });

	renderWithProviders(<McpCapabilitySheet name="context7" open onClose={() => {}} />);

	// Opens with focus already in the search field (the standard palette
	// pattern) — typing and arrowing compose without an extra click.
	const search = await screen.findByTestId("mcp-sheet-search");
	await waitFor(() => expect(search).toHaveFocus());

	const rows = await screen.findAllByTestId("mcp-sheet-row");
	expect(rows).toHaveLength(1);

	fireEvent.keyDown(search, { key: "ArrowDown" });
	expect(rows[0]).toHaveAttribute("data-selected", "true");
	expect(search).toHaveFocus();

	// Clicking a row moves DOM focus away from search; "/" brings it back.
	fireEvent.click(rows[0]);
	act(() => {
		rows[0].focus();
	});
	expect(search).not.toHaveFocus();
	fireEvent.keyDown(rows[0], { key: "/" });
	expect(search).toHaveFocus();
});
