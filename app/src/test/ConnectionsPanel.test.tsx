import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, primeRegistry, makeQueryClient } from "./helpers";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";

function renderPanel(
	over: Partial<React.ComponentProps<typeof ConnectionsPanel>> = {},
) {
	const client = makeQueryClient();
	primeRegistry(client, sampleRegistry);
	renderWithProviders(
		<ConnectionsPanel skillName="brainstorm" registry={sampleRegistry} {...over} />,
		{ client },
	);
}

// The equip hooks (`useSkillBundleEquip`) read/write the app's SINGLETON
// query client, not whatever client a test hands to `renderWithProviders` —
// the toast-body tests below prime and render through that singleton so the
// hook's optimistic read of `prev` registry actually sees the fixture.
beforeEach(() => {
	queryClient.clear();
	useAppStore.setState({ toasts: [] });
});

describe("ConnectionsPanel", () => {
	it("USED BY is open with bundles above projects as sub-groups of one list", () => {
		renderPanel();
		expect(screen.getByText("Used by")).toBeInTheDocument();
		// Both sub-groups mount at once, in the FILES navigator's group grammar.
		// R2: bundles come first — cause (toggle a bundle) above effect (the
		// project rows right under it flip to "via <bundle>").
		const groups = [...document.querySelectorAll(".equip-stack .equip-group-name")].map(
			(n) => n.textContent,
		);
		expect(groups).toEqual(["Bundles", "Projects"]);
		const listboxes = screen.getAllByRole("listbox");
		expect(listboxes).toHaveLength(2);
		expect(listboxes[0]).toHaveAccessibleName(/Bundles/);
		expect(listboxes[1]).toHaveAccessibleName(/Projects/);
		// DOM order backs up the array order above.
		expect(
			listboxes[0].compareDocumentPosition(listboxes[1]) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// The filter box appears only past 8 targets (the navigator's rule).
		expect(screen.queryByPlaceholderText("Filter projects…")).toBeNull();
	});

	it("SUB-AGENTS ships collapsed with its count on the head", () => {
		renderPanel();
		const head = screen.getByTestId("side-section-subagents");
		expect(head).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("button", { name: /Attach to sub-agent/ })).toBeNull();
		fireEvent.click(head);
		expect(screen.getByRole("button", { name: /Attach to sub-agent/ })).toBeInTheDocument();
	});

	// R4 — the bundle toggle's success toast names the consequence, not just
	// the ack. `android` (project-specific) is applied to `example-app` alone
	// in `sampleRegistry`, and `brainstorm` isn't one of its skills yet.
	it("names the applied project in the toast body when equipping onto a bundle", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "hub_cmd") return { success: true, output: "{}" };
			if (cmd === "check_python") return true;
			return undefined;
		});
		primeRegistry(queryClient, sampleRegistry);
		renderWithProviders(
			<ConnectionsPanel skillName="brainstorm" registry={sampleRegistry} />,
			{ client: queryClient },
		);
		const box = screen.getByRole("checkbox", { name: "Equip brainstorm android" });
		expect(box).not.toBeChecked();
		fireEvent.click(box);
		// `registry` is a static prop here (not re-derived from the query cache
		// by this standalone render), so the row's own checked state doesn't
		// flip in this test — the toast body is the thing R4 actually changed.
		await waitFor(() => {
			const toasts = useAppStore.getState().toasts;
			expect(
				toasts.some(
					(t) => t.title === "Added brainstorm to android" && t.body === "Now on example-app",
				),
			).toBe(true);
		});
	});

	it("says no project applies the bundle yet when it isn't applied anywhere", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "hub_cmd") return { success: true, output: "{}" };
			if (cmd === "check_python") return true;
			return undefined;
		});
		const registry = {
			...sampleRegistry,
			projects: {},
		};
		primeRegistry(queryClient, registry);
		renderWithProviders(
			<ConnectionsPanel skillName="brainstorm" registry={registry} />,
			{ client: queryClient },
		);
		const box = screen.getByRole("checkbox", { name: "Equip brainstorm android" });
		fireEvent.click(box);
		await waitFor(() => {
			const toasts = useAppStore.getState().toasts;
			expect(
				toasts.some(
					(t) =>
						t.title === "Added brainstorm to android" &&
						t.body === "No project applies android yet",
				),
			).toBe(true);
		});
	});
});
