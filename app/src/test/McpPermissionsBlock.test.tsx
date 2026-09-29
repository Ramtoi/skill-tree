import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { McpPermissionsBlock } from "@/components/mcp/McpPermissionsBlock";
import { deferredInvoke, renderWithProviders } from "./helpers";

const empty = { allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [] };
const state = vi.hoisted(() => ({ adoption: null as unknown, permissionError: false }));

vi.mock("@/hooks/useMcpCatalog", () => ({ useMcpCatalog: () => ({ data: { ok: true, catalog: { tools: [] } }, isLoading: false, isError: false, refetch: vi.fn() }) }));
// `usePermissionsDraft` runs for real here so `applyingMcp` reflects the
// hook's own state machine (driven by a hanging `invoke`), not a value the
// test hands the component directly. Keep `permsData` referentially stable
// across renders (only rebuilt when `state.adoption` changes) — real hook's
// load effect keys off it, so a fresh object every render would loop.
let permsDataCache: { key: unknown; data: unknown } = { key: Symbol("init"), data: null };
function permsData(): unknown {
	if (permsDataCache.key !== state.adoption) {
		permsDataCache = { key: state.adoption, data: { ...empty, adoption_required: state.adoption } };
	}
	return permsDataCache.data;
}
vi.mock("@/hooks/usePermissions", () => ({
	getAdoptionRequired: (data: unknown) => (data as { adoption_required?: unknown } | undefined)?.adoption_required ?? null,
	usePermissions: () => ({ data: permsData(), isLoading: false, isError: state.permissionError, refetch: vi.fn() }),
	usePermissionCapabilities: () => ({ data: { "claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"] }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

describe("MCP permissions block", () => {
	beforeEach(() => { state.adoption = null; state.permissionError = false; });
	it("keeps user-owned permissions editable for a source read-only MCP", () => {
		renderWithProviders(<McpPermissionsBlock name="files" sourceReadOnly />);
		expect(screen.getByText(/connection fields are read-only/i)).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "All tools permission" })).toBeEnabled();
	});

	it("shows an actionable adoption block and disables decisions", () => {
		state.adoption = { "claude-code": [{ pattern: "mcp__files", kind: "allow", source_file: "settings.json" }] };
		renderWithProviders(<McpPermissionsBlock name="files" />);
		expect(screen.getByRole("link", { name: /Open Global Permissions/i })).toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "All tools permission" })).toBeNull();
		state.adoption = null;
	});

	it("blocks decisions when the permission context errors and offers retry", () => {
		state.permissionError = true;
		renderWithProviders(<McpPermissionsBlock name="files" />);
		expect(screen.getByRole("alert")).toHaveTextContent(/failed to load/i);
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "All tools permission" })).toBeNull();
	});
	it("locks decisions while validating, then preserves a failed save for retry", async () => {
		// `applyMcpChanges` (the real hook) calls `permissions_validate` before
		// flipping `applyingMcp` back off; hang that call so the pending state
		// is the hook's own, not one the test hands the component.
		const validateGate = deferredInvoke((cmd) => cmd === "permissions_validate");
		let setCalls = 0;
		const prevImpl = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			if (cmd === "permissions_validate") return validateGate.promise;
			if (cmd === "permissions_set") {
				setCalls += 1;
				if (setCalls === 1) return Promise.reject(new Error("save failed"));
				return Promise.resolve({ normalized: empty, sync_rc: 0 });
			}
			return prevImpl ? prevImpl(cmd as never, args as never) : Promise.resolve(undefined);
		}) as never);

		renderWithProviders(<McpPermissionsBlock name="files" />);
		fireEvent.click(screen.getByRole("combobox", { name: "All tools permission" }));
		fireEvent.click(screen.getByRole("option", { name: "Deny" }));
		fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));

		await waitFor(() => expect(screen.getByRole("combobox", { name: "All tools permission" })).toBeDisabled());
		expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Save permissions" })).toBeDisabled();
		expect(setCalls).toBe(0);

		validateGate.resolve({ ok: true });
		await waitFor(() => expect(setCalls).toBe(1));
		await waitFor(() => expect(screen.getByRole("combobox", { name: "All tools permission" })).toBeEnabled());
		expect(screen.getByTestId("mcp-permission-staged")).toHaveTextContent("Deny");

		fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
		await waitFor(() => expect(screen.queryByTestId("mcp-permission-staged")).toBeNull());
		expect(setCalls).toBe(2);
	});

});
