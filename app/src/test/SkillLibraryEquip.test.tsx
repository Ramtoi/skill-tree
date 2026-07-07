import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import type { Registry } from "@/types";

function mockInvoke(impl: (cmd: string, args?: unknown) => unknown) {
	vi.mocked(invoke).mockImplementation(impl as never);
}

describe("SkillLibrary equip + empty states + candidate banner", () => {
	beforeEach(() => window.localStorage.clear());

	it("shows a create-first-skill CTA when the registry has zero skills", async () => {
		const empty: Registry = { ...sampleRegistry, skills: {}, bundles: {} };
		mockInvoke((cmd) => {
			if (cmd === "read_registry") return empty;
			if (cmd === "local_skill_candidates") return [];
			if (cmd === "harness_list") return [];
			if (cmd === "hub_cmd") return { success: true, output: '{"sources":[],"errors":[]}' };
			return undefined;
		});
		renderWithProviders(<SkillLibrary />, { client: makeQueryClient() });
		expect(await screen.findByText("Create your first skill")).toBeInTheDocument();
	});

	it("shows a filter-empty message distinct from the create CTA when skills exist", () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], sampleRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });
		fireEvent.change(
			screen.getByPlaceholderText("Search skills, tags, descriptions…"),
			{ target: { value: "zzz-no-such-skill" } },
		);
		expect(screen.getByText("No skills match your filters.")).toBeInTheDocument();
		expect(screen.queryByText("Create your first skill")).toBeNull();
	});

	it("surfaces detected candidates and adopts one via project import-skill", async () => {
		const calls: Array<string[]> = [];
		mockInvoke((cmd, args) => {
			if (cmd === "read_registry") return sampleRegistry;
			if (cmd === "harness_list") return [];
			if (cmd === "local_skill_candidates")
				return [
					{
						name: "hand-authored",
						project: "example-app",
						path: "/p/.claude/skills/hand-authored",
						category: "NEW",
						description: "authored in-project",
					},
				];
			if (cmd === "hub_cmd") {
				const a = (args as { args: string[] }).args;
				calls.push(a);
				if (a[0] === "source") return { success: true, output: '{"sources":[],"errors":[]}' };
				return { success: true, output: "" };
			}
			return undefined;
		});
		renderWithProviders(<SkillLibrary />, { client: makeQueryClient() });
		const adopt = await screen.findByRole("button", { name: "Adopt" });
		fireEvent.click(adopt);
		await waitFor(() =>
			expect(
				calls.some(
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
