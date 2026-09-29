import { fireEvent, screen } from "@testing-library/react";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { deferredInvoke, makeQueryClient, primeRegistry, renderWithProviders } from "./helpers";
import { describe, expect, it } from "vitest";
import { classificationValues, groupedClassificationEntries, passesClassification } from "@/lib/libraryClassification";
import type { Skill } from "@/types";

const skill = (classification?: Skill["classification"]): Skill => ({ version: "1", description: "", source: "local", type: "claude-skill", scope: "global", upstream: null, classification });

describe("library classification", () => {
	it("matches assigned and referenced classes by ASCII identity", () => {
		const a = skill({ classes: ["Process"] });
		const summary = { classes: [{ value: "Process", provenance: "assigned" as const, contributors: [] }], outputs: [] };
		expect(passesClassification(a, summary, "process", "all", "references")).toBe(true);
		expect(passesClassification(a, summary, "delivery", "all", "references")).toBe(false);
		expect(passesClassification(skill(), undefined, null, "all", "assigned")).toBe(true);
	});
	it("repeats a skill in each class and keeps an Unclassified group", () => {
		const entries: Array<[string, Skill]> = [["a", skill({ classes: ["process", "delivery"] })], ["b", skill()]];
		const groups = groupedClassificationEntries(entries, "class");
		expect(groups.map((g) => g.label)).toEqual(["DELIVERY", "PROCESS", "UNCLASSIFIED"]);
		expect(groups.find((g) => g.label === "DELIVERY")?.items).toHaveLength(1);
		const collision = groupedClassificationEntries([["c", skill({ classes: ["__unclassified__"] })], ["d", skill()]], "class");
		expect(collision).toHaveLength(2);
		expect(collision.find((g) => g.label === "__UNCLASSIFIED__")?.items).toHaveLength(1);
	});
	it("groups only assigned classes while filters can match references", () => {
		const entries: Array<[string, Skill]> = [["a", skill({ classes: ["process", "delivery"] })], ["b", skill()]];
		const summaries = new Map(entries.map(([name]) => [name, { classes: [
			{ value: "inherited", provenance: "direct" as const, contributors: ["other"] },
			{ value: "deep", provenance: "indirect" as const, contributors: ["nested"] },
		], outputs: [] }]));
		expect(groupedClassificationEntries(entries, "class").map((g) => [g.label, g.items.map(([name]) => name)])).toEqual([
			["DELIVERY", ["a"]], ["PROCESS", ["a"]], ["UNCLASSIFIED", ["b"]],
		]);
		expect(passesClassification(entries[0][1], summaries.get("a"), "inherited", "all", "references")).toBe(true);
	});
	it("orders assigned chips alphabetically while reference data is unavailable", () => {
		const a = skill({ classes: ["Zulu", "beta", "Alpha"] });
		expect(classificationValues(a, undefined, "references").classes.map((item) => item.value)).toEqual(["Alpha", "beta", "Zulu"]);
		expect(a.classification?.classes).toEqual(["Zulu", "beta", "Alpha"]);
	});
	it("orders working mode groups and assigns missing values to Unspecified", () => {
		const entries: Array<[string, Skill]> = [["a", skill({ working_mode: "mixed" })], ["b", skill()]];
		const groups = groupedClassificationEntries(entries, "mode");
		expect(groups.map((g) => g.label)).toEqual(["MIXED", "UNSPECIFIED"]);
	});
});

 it("shows assigned class groups while the reference graph is pending", () => {
	window.localStorage.clear();
	const client = makeQueryClient();
	primeRegistry(client);
	deferredInvoke((cmd, args) => cmd === "hub_cmd" && JSON.stringify(args).includes('"refs"'));
	renderWithProviders(<SkillLibrary />, { client });
	fireEvent.click(screen.getByTitle("Group by class"));
	expect(screen.getByText("brainstorm").closest(".skill-row")).toBeInTheDocument();
	expect(screen.queryByText("Loading classifications")).not.toBeInTheDocument();
 });

it("keeps reference class filtering pending until the graph resolves", () => {
	window.localStorage.clear();
	const client = makeQueryClient();
	primeRegistry(client);
	deferredInvoke((cmd, args) => cmd === "hub_cmd" && JSON.stringify(args).includes('"refs"'));
	renderWithProviders(<SkillLibrary />, { client, initialRoute: "/?class=inherited" });
	fireEvent.click(screen.getByTitle("Group by class"));
	expect(screen.getByText("Loading classifications")).toBeInTheDocument();
	expect(screen.queryByText("brainstorm")).not.toBeInTheDocument();
});
