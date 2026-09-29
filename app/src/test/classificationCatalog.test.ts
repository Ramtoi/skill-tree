import { describe, expect, it } from "vitest";
import { CLASSIFICATION_CATALOG, classificationLabel, searchClassificationCatalog } from "@/lib/classificationCatalog";

describe("classification catalog", () => {
	it("contains the approved eight classes and nine outputs", () => {
		expect(CLASSIFICATION_CATALOG.classes).toHaveLength(8);
		expect(CLASSIFICATION_CATALOG.outputs).toHaveLength(9);
		expect(classificationLabel("classes", "implementation")).toBe("Build");
		expect(classificationLabel("outputs", "release")).toBe("PR / release");
	});

	it("searches canonical labels, descriptions, and former terms without changing values", () => {
		expect(searchClassificationCatalog("outputs", "regression evidence").map((entry) => entry.value)).toContain("evidence");
		expect(searchClassificationCatalog("classes", "hands-on setup").map((entry) => entry.value)).toContain("implementation");
		expect(searchClassificationCatalog("classes", "research")).toHaveLength(1);
	});
});
