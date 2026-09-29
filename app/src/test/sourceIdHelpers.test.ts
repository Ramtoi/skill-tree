import { describe, it, expect } from "vitest";
import {
	deriveSourceIdFromUrl,
	parseGitSourceUrl,
	sourceIdError,
	suggestFreeSourceId,
	suggestSourceIdForUrl,
	takenSourceIds,
} from "@/lib/skillSource";
import type { Registry } from "@/types";

describe("parseGitSourceUrl", () => {
	it("leaves a plain SSH/HTTPS url alone", () => {
		expect(parseGitSourceUrl("git@github.com:org/skills.git")).toEqual({
			cloneUrl: "git@github.com:org/skills.git",
		});
		expect(parseGitSourceUrl("https://github.com/org/skills")).toEqual({
			cloneUrl: "https://github.com/org/skills",
		});
	});

	it("splits a /tree/ deep link into repo + branch + subpath", () => {
		expect(
			parseGitSourceUrl(
				"https://github.com/cursor/plugins/tree/main/pstack/skills/unslop",
			),
		).toEqual({
			cloneUrl: "https://github.com/cursor/plugins",
			branch: "main",
			subpath: "pstack/skills/unslop",
		});
	});

	it("splits a /blob/ deep link and drops the SKILL.md filename", () => {
		expect(
			parseGitSourceUrl(
				"https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md",
			),
		).toEqual({
			cloneUrl: "https://github.com/cursor/plugins",
			branch: "main",
			subpath: "pstack/skills/unslop",
		});
	});

	it("tolerates a trailing slash and a .git repo segment", () => {
		expect(
			parseGitSourceUrl(
				"https://github.com/cursor/plugins.git/blob/main/pstack/skills/unslop/",
			),
		).toEqual({
			cloneUrl: "https://github.com/cursor/plugins",
			branch: "main",
			subpath: "pstack/skills/unslop",
		});
	});

	it("keeps the branch when a deep link names no subpath", () => {
		expect(parseGitSourceUrl("https://github.com/org/repo/tree/dev")).toEqual({
			cloneUrl: "https://github.com/org/repo",
			branch: "dev",
		});
	});

	it("returns an empty clone url for an empty input", () => {
		expect(parseGitSourceUrl("")).toEqual({ cloneUrl: "" });
	});
});

describe("suggestSourceIdForUrl", () => {
	it("names the deep-linked directory, not the monorepo", () => {
		expect(
			suggestSourceIdForUrl(
				"https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md",
			),
		).toBe("unslop");
	});
	it("falls back to the repo name without a subpath", () => {
		expect(suggestSourceIdForUrl("https://github.com/cursor/plugins")).toBe("plugins");
		expect(suggestSourceIdForUrl("https://github.com/org/repo/tree/main")).toBe("repo");
	});
	it("slugifies the directory name", () => {
		expect(
			suggestSourceIdForUrl("https://github.com/org/repo/tree/main/skills/My_Skill"),
		).toBe("my-skill");
	});
});

describe("deriveSourceIdFromUrl", () => {
	it("derives the repo slug from an SSH url", () => {
		expect(deriveSourceIdFromUrl("git@github.com:org/skills.git")).toBe("skills");
	});
	it("derives from HTTPS, with or without .git", () => {
		expect(deriveSourceIdFromUrl("https://github.com/org/skills.git")).toBe("skills");
		expect(deriveSourceIdFromUrl("https://github.com/org/skills")).toBe("skills");
	});
	it("slugifies non-slug characters", () => {
		expect(deriveSourceIdFromUrl("https://github.com/org/My_Repo")).toBe("my-repo");
	});
	it("strips a GitHub tree/<branch>/<path> suffix", () => {
		expect(deriveSourceIdFromUrl("https://github.com/org/repo/tree/main/skills")).toBe(
			"repo",
		);
	});
	it("tolerates a trailing slash", () => {
		expect(deriveSourceIdFromUrl("https://github.com/org/skills/")).toBe("skills");
	});
	it("returns empty for an empty url", () => {
		expect(deriveSourceIdFromUrl("")).toBe("");
		expect(deriveSourceIdFromUrl("   ")).toBe("");
	});
});

describe("suggestFreeSourceId", () => {
	it("returns the base when free", () => {
		expect(suggestFreeSourceId("skills", new Set())).toBe("skills");
	});
	it("bumps past a single collision", () => {
		expect(suggestFreeSourceId("skills", new Set(["skills"]))).toBe("skills-2");
	});
	it("bumps past consecutive collisions", () => {
		expect(suggestFreeSourceId("skills", new Set(["skills", "skills-2"]))).toBe(
			"skills-3",
		);
	});
	it("passes an empty base through", () => {
		expect(suggestFreeSourceId("", new Set(["x"]))).toBe("");
	});
	it("keeps searching past many collisions — never returns a taken base", () => {
		const taken = new Set(["skills"]);
		for (let n = 2; n <= 1200; n++) taken.add(`skills-${n}`);
		const free = suggestFreeSourceId("skills", taken);
		expect(free).toBe("skills-1201");
		expect(taken.has(free)).toBe(false);
	});
});

describe("takenSourceIds", () => {
	it("always reserves the built-in ids", () => {
		const taken = takenSourceIds(undefined);
		expect(taken.has("local")).toBe(true);
		expect(taken.has("starter")).toBe(true);
	});
	it("includes configured git sources", () => {
		const reg = { sources: { "org-skills": { type: "git" } } } as unknown as Registry;
		const taken = takenSourceIds(reg);
		expect(taken.has("org-skills")).toBe(true);
		expect(taken.has("local")).toBe(true);
	});
});

describe("sourceIdError", () => {
	const taken = new Set(["local", "starter", "org-skills"]);
	it("returns null for an empty id (backend derives)", () => {
		expect(sourceIdError("", taken)).toBeNull();
	});
	it("flags a reserved id", () => {
		expect(sourceIdError("local", taken)).toBe("reserved");
	});
	it("flags an already-configured id", () => {
		expect(sourceIdError("org-skills", taken)).toBe("taken");
	});
	it("flags an invalid slug", () => {
		expect(sourceIdError("Not Valid", taken)).toBe("invalid");
		expect(sourceIdError("UPPER", taken)).toBe("invalid");
	});
	it("accepts a free, valid slug", () => {
		expect(sourceIdError("my-skills", taken)).toBeNull();
	});
});
