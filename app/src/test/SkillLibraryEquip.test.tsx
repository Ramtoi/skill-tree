import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, sampleRegistry, makeQueryClient, mockCommands } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import type { Registry } from "@/types";

describe("SkillLibrary equip + empty states + candidate banner", () => {
	beforeEach(() => window.localStorage.clear());

	it("shows a create-first-skill CTA when the registry has zero skills", async () => {
		const empty: Registry = { ...sampleRegistry, skills: {}, bundles: {} };
		mockCommands({
			read_registry: empty,
			local_skill_candidates: [],
			harness_list: [],
			// m12: this registry is FULLY empty (no skills, no bundles) — explicit
			// so the dock-visibility assertions below aren't accidentally
			// riding on an unmocked query resolving to undefined.
			snippets_list: [],
			hub_cmd: { success: true, output: '{"sources":[],"errors":[]}' },
		});
		renderWithProviders(<SkillLibrary />, { client: makeQueryClient() });
		const heading = await screen.findByText("Create your first skill");
		expect(heading).toBeInTheDocument();

		// F8: a second, non-dead-end action sits alongside "New skill" so a
		// brand-new registry with zero skills isn't a one-way door. Scope to the
		// empty-state container — the screen header also has its own "New skill"
		// primary button, so an unscoped query would be ambiguous.
		const emptyState = heading.closest(".empty-state") as HTMLElement;
		expect(emptyState).not.toBeNull();
		const scoped = within(emptyState);
		expect(scoped.getByRole("button", { name: "New skill" })).toBeInTheDocument();
		const addProjectBtn = scoped.getByRole("button", { name: "Add project" });
		expect(addProjectBtn).toBeInTheDocument();

		await userEvent.click(addProjectBtn);
		await waitFor(() =>
			expect(document.querySelector(".modal-title")?.textContent).toBe(
				"Add project",
			),
		);
	});

	/**
	 * B8 — an empty registry used to render the full toolbar (ALL 0 / SKILL 0 /
	 * MCP 0 / Filter / list-grid) and a "0 of 0" tag above a screen with nothing
	 * in it. That chrome only measures its own emptiness, and reads as a broken
	 * filter rather than a fresh install.
	 */
	it("suppresses the zero-count toolbar when the registry itself is empty", async () => {
		const empty: Registry = { ...sampleRegistry, skills: {}, bundles: {} };
		mockCommands({
			read_registry: empty,
			local_skill_candidates: [],
			harness_list: [],
			// m12: this registry is FULLY empty (no skills, no bundles) — explicit
			// so the dock-visibility assertions below aren't accidentally
			// riding on an unmocked query resolving to undefined.
			snippets_list: [],
			hub_cmd: { success: true, output: '{"sources":[],"errors":[]}' },
		});
		renderWithProviders(<SkillLibrary />, { client: makeQueryClient() });
		await screen.findByText("Create your first skill");

		expect(screen.queryByTestId("floating-search-input")).toBeNull();
		// The kind chips moved into the bar, which is itself suppressed on an
		// empty registry — asserting the bar's absence covers both.
		expect(screen.queryByTestId("floating-search")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Filter/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "List view" })).toBeNull();
		expect(screen.queryByText("0 of 0")).toBeNull();

		// The empty state names the concept rather than restating the blank screen.
		expect(
			screen.getByText(/a folder of instructions your coding agent loads on demand/i),
		).toBeInTheDocument();
	});

	/** …and the toolbar returns the moment a skill exists — this is NOT the
	 *  filtered-to-zero case, which still needs its filters on screen to undo.
	 *  The Filter chip only exists once the row's SOURCE/TRIGGER facets don't
	 *  fit (jsdom's default `useFitsInline` measurement is "fits") — the
	 *  toolbar itself is what survives, so this checks the subheader and its
	 *  inline SOURCE facet instead of a chip that is conditionally absent. */
	it("keeps the toolbar when a filter — not the registry — is what is empty", () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], sampleRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });
		fireEvent.change(screen.getByTestId("floating-search-input"), {
			target: { value: "zzz-no-such-skill" },
		});
		expect(screen.getByText("No matching skills")).toBeInTheDocument();
		expect(screen.getByTestId("floating-search-input")).toBeInTheDocument();
		expect(document.querySelector(".main-subheader")).not.toBeNull();
		expect(screen.getByRole("combobox", { name: "Source" })).toBeInTheDocument();
	});

	it("shows a filter-empty message distinct from the create CTA when skills exist", () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], sampleRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });
		fireEvent.change(screen.getByTestId("floating-search-input"), {
			target: { value: "zzz-no-such-skill" },
		});
		expect(screen.getByText("No matching skills")).toBeInTheDocument();
		expect(screen.queryByText("Create your first skill")).toBeNull();
	});

	it("surfaces detected candidates and adopts one via project import-skill", async () => {
		const recorder = mockCommands({
			read_registry: sampleRegistry,
			harness_list: [],
			snippets_list: [],
			local_skill_candidates: [
				{
					name: "hand-authored",
					project: "example-app",
					path: "/p/.claude/skills/hand-authored",
					category: "NEW",
					description: "authored in-project",
				},
			],
			hub_cmd: (args: unknown) => {
				const a = (args as { args: string[] }).args;
				if (a[0] === "source") return { success: true, output: '{"sources":[],"errors":[]}' };
				return { success: true, output: "" };
			},
		});
		renderWithProviders(<SkillLibrary />, { client: makeQueryClient() });
		const adopt = await screen.findByRole("button", { name: "Adopt" });
		fireEvent.click(adopt);
		await waitFor(() =>
			expect(
				recorder
					.of("hub_cmd")
					.map((args) => (args as { args: string[] }).args)
					.some(
						(a) =>
							a[0] === "project" &&
							a[1] === "import-skill" &&
							a[2] === "hand-authored" &&
							a.includes("example-app"),
					),
			).toBe(true),
		);
	});

	it("opens the equip picker from a Library row's equip action", () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], sampleRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });
		const equipBtns = screen.getAllByTitle("Equip on…");
		fireEvent.click(equipBtns[0]);
		expect(screen.getByPlaceholderText("Equip on project…")).toBeInTheDocument();
	});
});
