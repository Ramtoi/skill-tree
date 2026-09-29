import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpPermissionSheet } from "@/components/mcp/McpPermissionSheet";
import type { NormalizedPermissions } from "@/types/permissions";
import { renderWithProviders } from "./helpers";

vi.mock("@/hooks/useMcpCatalog", () => ({
	useMcpCatalog: () => ({ data: { ok: true, catalog: { tools: [{ name: "read_file", title: null, description: null, parameters: [], schema_unreadable: false, parameters_truncated: false }] } }, isLoading: false, isError: false }),
}));
vi.mock("@/hooks/usePermissions", () => ({
	usePermissions: () => ({ data: { allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
	usePermissionCapabilities: () => ({ data: { "claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"] }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const draft: NormalizedPermissions = { allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [] };

describe("MCP permission sheet", () => {
	it("keeps staged decisions visible when the parent rejects the apply", async () => {
		const onApply = vi.fn().mockResolvedValue(false);
		renderWithProviders(<McpPermissionSheet open server="files" servers={["files", "search"]} scope={{ kind: "global" }} draft={draft} onClose={vi.fn()} onApply={onApply} />);
		fireEvent.click(screen.getByRole("combobox", { name: "All tools permission" }));
		fireEvent.click(screen.getByRole("option", { name: /Deny/ }));
		fireEvent.click(screen.getByRole("button", { name: "Add permissions" }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith([{ server: "files", tool: undefined, decision: "deny", harnesses: null }]));
		expect(screen.getByRole("alert")).toHaveTextContent("still staged");
		expect(screen.getByRole("combobox", { name: "All tools permission" })).toHaveTextContent("Deny");
	});

	it("keeps queued changes while switching registered servers", () => {
		renderWithProviders(<McpPermissionSheet open server="files" servers={["files", "search"]} scope={{ kind: "project", name: "demo" }} draft={draft} onClose={vi.fn()} onApply={vi.fn().mockResolvedValue(true)} />);
		fireEvent.click(screen.getByRole("combobox", { name: "All tools permission" }));
		fireEvent.click(screen.getByRole("option", { name: /Allow/ }));
		fireEvent.change(screen.getByRole("combobox", { name: "MCP server" }), { target: { value: "search" } });
		expect(screen.getByTestId("mcp-permission-staged")).toHaveTextContent("all tools → Allow");
	});

	it("passes the explicit selected payload and closes only after success", async () => {
		const onApply = vi.fn().mockResolvedValue(true);
		const onClose = vi.fn();
		renderWithProviders(<McpPermissionSheet open server="files" scope={{ kind: "project", name: "demo" }} personalActive draft={draft} onClose={onClose} onApply={onApply} />);
		fireEvent.click(screen.getByRole("combobox", { name: "All tools permission" }));
		fireEvent.click(screen.getByRole("option", { name: /Ask/ }));
		fireEvent.click(screen.getByRole("button", { name: "Add permissions" }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith([{ server: "files", tool: undefined, decision: "ask", harnesses: null }]));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(screen.getByText("Project demo · Personal")).toBeInTheDocument();
	});
});
