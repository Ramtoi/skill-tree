import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, sampleRegistry, makeQueryClient, mockCommands } from "./helpers";
import { ToastContainer } from "@/components/Toast";
import { SkillLibrary } from "@/screens/SkillLibrary";
import type { McpCandidate } from "@/lib/mcpContract";
import type { McpReconcilePayload } from "@/hooks/useMcpCandidates";

// Journey: "Library: the Detected MCP servers band adopts a new candidate
// with an undo toast" (mcp-panel.journey.spec.ts ~:187, plan row mcp-panel
// "cut :187"). The library mount (`SkillLibrary.tsx`'s
// `onAdopt={(cand) => adoptMcp(cand)}` and the band's visibility condition)
// had no vitest importer — `detectedMcpServers.test.tsx` renders the band
// and `useMcpDecisions()` directly, explicitly leaving "this hook actually
// living in SkillLibrary, wired to the real useMcpCandidates query" to the
// e2e journey this test replaces.

const WEATHER_API: McpCandidate = {
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
};

const RECONCILE_PAYLOAD: McpReconcilePayload = {
	ok: true,
	scope_kind: "global",
	project: null,
	candidates: [WEATHER_API],
	kept: [],
};

describe("SkillLibrary Detected MCP servers band", () => {
	it("the library mounts the Detected MCP servers band and Adopt imports the candidate", async () => {
		mockCommands({
			read_registry: sampleRegistry,
			harness_list: [],
			snippets_list: [],
			local_skill_candidates: [],
			hub_cmd: (args: unknown) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "mcp" && a[1] === "reconcile") {
					return { success: true, output: JSON.stringify(RECONCILE_PAYLOAD) };
				}
				return { success: true, output: '{"sources":[],"errors":[]}' };
			},
			mcp_reconcile_apply: {
				ok: true,
				imported: ["weather-api"],
				kept: [],
				unkept: [],
				skipped: [],
				conflicts_resolved: 0,
				synced: true,
				suggested_refs: [],
				renamed: [],
				claimed: [],
				removed_native: [],
				errors: [],
			},
		});

		renderWithProviders(
			<>
				<SkillLibrary />
				<ToastContainer />
			</>,
			{ client: makeQueryClient() },
		);

		const band = await screen.findByTestId("detected-mcp-servers");
		expect(band).toBeInTheDocument();
		const row = await screen.findByText("weather-api");
		expect(row).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Adopt" }));

		await waitFor(() => expect(screen.getByText("Adopted weather-api.")).toBeInTheDocument());
	});
});
