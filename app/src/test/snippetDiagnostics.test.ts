import { describe, expect, it } from "vitest";
import {
	snippetMarkerLine,
	snippetMarkerProblem,
	snippetMarkerSaveMessage,
} from "@/lib/snippetDiagnostics";

describe("snippet marker diagnostics", () => {
	it.each([
		["nested-start", "nested start marker"],
		["incomplete-block", "missing end marker"],
		["mismatched-end", "end marker has a different snippet name"],
		["duplicate-id", "duplicate snippet block"],
		["unmatched-end", "end marker has no start marker"],
		["malformed-token", "malformed marker comment"],
	])("names %s without exposing parser tokens", (kind, label) => {
		expect(snippetMarkerProblem(kind)).toBe(label);
	});

	it("includes the first line and the number of remaining problems", () => {
		const diagnostics = [
			{ kind: "malformed-token", name: null, line: 12 },
			{ kind: "unmatched-end", name: "delivery", line: 18 },
		];

		expect(snippetMarkerLine(diagnostics[0])).toBe(
			"Line 12: malformed marker comment",
		);
		expect(snippetMarkerSaveMessage(diagnostics)).toBe(
			"Line 12: malformed marker comment. Repair this marker and 1 other problem. Then save again.",
		);
	});
});
