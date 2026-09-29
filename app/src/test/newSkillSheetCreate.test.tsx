import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, primeRegistry } from "./helpers";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";

// ─── Standalone "Create skill" path — design.md create-then-follow-up,
// Decision 1/11: the sheet awaits ONLY `qk.registry()` before closing, then
// fires the derived-keys invalidation un-awaited (`invalidateRegistryDerived`,
// which skips the registry key itself). A regression back to the full
// `invalidateRegistry()` there would queue a second, un-awaited registry
// refetch — this counts `read_registry` invocations to catch that.

function installInvoke() {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return queryClient.getQueryData(["registry"]);
		if (cmd === "hub_cmd") {
			const cmdArgs = ((args as { args?: string[] } | undefined)?.args) ?? [];
			if (cmdArgs[0] === "new") return { success: true, output: "" };
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
}

function renderSheet() {
	// `NewSkillSheet` writes/reads through the SINGLETON `queryClient`
	// (`@/lib/queryClient`) — render against that same singleton so the
	// invalidate-triggered refetch is observable here.
	primeRegistry(queryClient);
	const onClose = vi.fn();
	renderWithProviders(
		<>
			<NewSkillSheet open onClose={onClose} />
			<ToastContainer />
		</>,
		{ client: queryClient },
	);
	return { onClose };
}

beforeEach(() => {
	queryClient.clear();
	useAppStore.setState({ toasts: [] });
	installInvoke();
});

describe("NewSkillSheet — standalone create path", () => {
	it("issues exactly ONE read_registry invocation after `hub new` resolves", async () => {
		const { onClose } = renderSheet();

		// Mount settled (the name field is the sheet's own first paint); the
		// mock registry is primed straight into the cache and fresh, so
		// `useRegistry()` does not itself issue a mount-time read here — the
		// delta below isolates whatever the submit path causes on its own.
		const nameField = await screen.findByPlaceholderText("my-skill-name");
		const before = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "read_registry").length;

		fireEvent.change(nameField, { target: { value: "brand-new-skill" } });
		fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		await waitFor(() => {
			const after = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "read_registry").length;
			expect(after - before).toBe(1);
		});
	});
});
