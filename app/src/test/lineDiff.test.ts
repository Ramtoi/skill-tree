import { describe, it, expect } from "vitest";
import { lineDiff, isUnchanged, type DiffOp } from "@/lib/lineDiff";
import { composeSkillDocument } from "@/lib/composeSkillDocument";

function allOps(hunks: ReturnType<typeof lineDiff>): DiffOp[] {
	return hunks.flatMap((h) => h.ops);
}

describe("lineDiff", () => {
	it("identical inputs → no hunks / isUnchanged", () => {
		const text = "a\nb\nc";
		const hunks = lineDiff(text, text);
		expect(hunks).toEqual([]);
		expect(isUnchanged(hunks)).toBe(true);
	});

	it("a single inserted line near the top marks exactly one added line", () => {
		const original = "line1\nline2\nline3\nline4\nline5";
		const current = "line1\nINSERTED\nline2\nline3\nline4\nline5";
		const hunks = lineDiff(original, current);
		expect(isUnchanged(hunks)).toBe(false);
		const ops = allOps(hunks);
		const added = ops.filter((o) => o.kind === "+");
		const removed = ops.filter((o) => o.kind === "-");
		expect(added).toHaveLength(1);
		expect(added[0].text).toBe("INSERTED");
		// The naive index-aligned diff would cascade removals; the real diff must not.
		expect(removed).toHaveLength(0);
	});

	it("trims a shared prefix and suffix around a changed middle", () => {
		const original = ["h1", "h2", "h3", "MID", "f1", "f2", "f3"].join("\n");
		const current = ["h1", "h2", "h3", "CHANGED", "f1", "f2", "f3"].join("\n");
		const hunks = lineDiff(original, current);
		const ops = allOps(hunks);
		// The one changed line becomes -MID / +CHANGED; the rest are context only.
		expect(ops.filter((o) => o.kind === "-").map((o) => o.text)).toEqual(["MID"]);
		expect(ops.filter((o) => o.kind === "+").map((o) => o.text)).toEqual([
			"CHANGED",
		]);
		// Shared prefix/suffix survive as context (not re-emitted as changes).
		expect(ops.some((o) => o.kind === " " && o.text === "h1")).toBe(true);
		expect(ops.some((o) => o.kind === " " && o.text === "f3")).toBe(true);
	});

	it("groups distant changes into separate hunks", () => {
		const base = Array.from({ length: 30 }, (_, i) => `line${i}`);
		const a = base.join("\n");
		const bArr = [...base];
		bArr[2] = "CHANGED_TOP";
		bArr[27] = "CHANGED_BOTTOM";
		const hunks = lineDiff(a, bArr.join("\n"));
		expect(hunks.length).toBe(2);
		expect(hunks[0].header.startsWith("@@")).toBe(true);
	});

	it("frontmatter metadata change shows via composeSkillDocument (body unchanged)", () => {
		const body = "# Title\n\nSome body text.";
		const original = composeSkillDocument(
			{ name: "my-skill", description: "old desc" },
			body,
		);
		const current = composeSkillDocument(
			{ name: "my-skill", description: "new desc" },
			body,
		);
		const hunks = lineDiff(original, current);
		expect(isUnchanged(hunks)).toBe(false);
		const ops = allOps(hunks);
		expect(ops.some((o) => o.kind === "+" && o.text.includes("new desc"))).toBe(
			true,
		);
		expect(ops.some((o) => o.kind === "-" && o.text.includes("old desc"))).toBe(
			true,
		);
	});
});
