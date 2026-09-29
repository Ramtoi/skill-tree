import { describe, it, expect } from "vitest";
import { plural } from "@/lib/plural";

describe("plural", () => {
	it("uses the singular form for exactly one", () => {
		expect(plural(1, "skill")).toBe("skill");
		expect(`${1} ${plural(1, "skill")}`).toBe("1 skill");
	});

	it("uses the plural form for zero and for many", () => {
		expect(plural(0, "skill")).toBe("skills");
		expect(plural(2, "skill")).toBe("skills");
		expect(plural(11, "conflict")).toBe("conflicts");
	});

	it("takes an explicit plural for irregular nouns", () => {
		expect(plural(1, "entry", "entries")).toBe("entry");
		expect(plural(3, "entry", "entries")).toBe("entries");
	});

	it("treats -1 as singular", () => {
		expect(plural(-1, "skill")).toBe("skill");
	});
});
