import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpPermissionControls } from "@/components/mcp/McpPermissionControls";
import type { Capabilities, NormalizedPermissions } from "@/types/permissions";
import type { McpPermissionChange } from "@/lib/mcpPermissionRules";
import type { McpCatalogTool } from "@/lib/mcpContract";
import { renderWithProviders } from "./helpers";

const empty: NormalizedPermissions = { allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [] };
const caps: Capabilities = { "claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"] };

function renderControls(draft: NormalizedPermissions = empty, changes: McpPermissionChange[] = [], tools: McpCatalogTool[] = []) {
	return renderWithProviders(<McpPermissionControls server="files" tools={tools} draft={draft} changes={changes} otherScopes={[]} capabilities={caps} scopeKind="global" onChange={vi.fn()} />);
}

describe("MCP permission controls", () => {
	it("keeps All tools and manual entry usable without a catalog", () => {
		renderControls();
		expect(screen.getByRole("combobox", { name: "All tools permission" })).toBeEnabled();
		fireEvent.change(screen.getByRole("textbox", { name: "Exact MCP tool name" }), { target: { value: "read_file" } });
		fireEvent.click(screen.getByRole("button", { name: "Add tool" }));
		expect(screen.getByRole("combobox", { name: "read_file permission" })).toBeInTheDocument();
	});

	it("leaves an ambiguous exact rule untouched and uneditable", () => {
		renderControls({ ...empty, allow: [{ pattern: "mcp__files__read_file", kind: "allow", harnesses: ["claude-code"] }], deny: [{ pattern: "mcp__files__read_file", kind: "deny", harnesses: ["codex"] }] });
		expect(screen.getByRole("combobox", { name: "read_file permission" })).toBeDisabled();
		expect(screen.getByText(/Separate rules have different decisions/)).toBeInTheDocument();
	});

	it("shows retained affinity and supported harness context", () => {
		renderControls({ ...empty, allow: [{ pattern: "mcp__files__read_file", kind: "allow", harnesses: ["claude-code"] }] });
		expect(screen.getByText(/Coding tools:/)).toHaveTextContent("claude-code");
		expect(screen.getByText(/Supported: claude-code/)).toBeInTheDocument();
	});

	it("does not offer an effective Allow exception under a staged broad Ask", () => {
		renderControls(empty, [{ server: "files", decision: "ask", tool: undefined, harnesses: null }], [{ name: "read_file", title: null, description: null, parameters: [], schema_unreadable: false, parameters_truncated: false }]);
		fireEvent.click(screen.getByRole("combobox", { name: "read_file permission" }));
		expect(screen.queryByRole("option", { name: /^Allow/ })).toBeNull();
	});
	it("shows inherited rules as context while the project choice remains Default", () => {
		const context = { ...empty, deny: [{ pattern: "mcp__files", kind: "deny" as const, origin: "global" as const }] };
		renderWithProviders(<McpPermissionControls server="files" tools={[]} draft={empty} changes={[]} otherScopes={[context]} capabilities={caps} scopeKind="project" onChange={vi.fn()} />);
		expect(screen.getByText("Rules from other scopes (1)")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "All tools permission" })).toHaveTextContent("Default");
		fireEvent.click(screen.getByRole("combobox", { name: "All tools permission" }));
		expect(screen.queryByRole("option", { name: "Allow" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Ask" })).toBeNull();
		expect(screen.getByRole("option", { name: "Deny" })).toBeInTheDocument();
	});

});
