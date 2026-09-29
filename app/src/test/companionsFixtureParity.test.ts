// Fixture parity (C9): the mock registry's `orchestrate-advanced.ships_with`
// block (src/mocks/tauriCore.ts) must match, name-for-name and
// count-for-count, the real fixture's SKILL.md frontmatter at
// tests/fixtures/ships_with/orchestrate-advanced/SKILL.md — written by a
// SIBLING unit in parallel (plan 3 / U1). This test is TEXT-level on purpose:
// `app/` has no YAML dependency and this change does not earn one.
//
// This may be RED until that sibling unit lands its fixture file — see the
// implementation report's Follow-ups.
//
// W-7 (review, milestone 6): the original version only asserted the MOCK's
// counts and that each mock name appears SOMEWHERE in the fixture text — a
// 7th agent, or a changed hook `event`/`command`, added to the fixture would
// leave the mock stale and this suite green. Every expectation below is now
// derived by PARSING the fixture's own `ships_with:` block (agents/hooks/
// permissions), then asserted equal to the mock in BOTH directions (every
// mock entry exists in the parsed fixture and vice versa, with identical
// fields per hook) — no hand-typed name list survives independently of the
// fixture text, so a drift in either direction fails the test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registry } from "@/mocks/tauriCore";
import { isHookRef } from "@/lib/companions";

const FIXTURE_PATH = resolve(
	process.cwd(),
	"../tests/fixtures/ships_with/orchestrate-advanced/SKILL.md",
);

/** Pull the `ships_with:` block out of a SKILL.md's frontmatter, from the
 *  `ships_with:` line up to (not including) the closing `---`. */
function extractShipsWithBlock(skillMd: string): string {
	const lines = skillMd.split("\n");
	const start = lines.findIndex((l) => l.trim() === "ships_with:");
	if (start === -1) {
		throw new Error("No `ships_with:` block found in the fixture's frontmatter");
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^---\s*$/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trimEnd();
}

interface ParsedHook {
	name: string;
	event: string;
	command: string;
	activation: string;
	tools: string[];
}

interface ParsedShipsWith {
	agents: string[];
	hooks: ParsedHook[];
	permissions: { allow: string[]; deny: string[]; ask: string[] };
}

/** `[a, b, c]` / `["a", "b"]` / `[]` -> a trimmed, unquoted string array. Not a
 *  general YAML flow-list parser — just enough for this fixture's shapes. */
function parseFlowList(raw: string): string[] {
	const inner = raw.trim().replace(/^\[/, "").replace(/\]\s*$/, "");
	if (!inner.trim()) return [];
	return inner
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter((s) => s.length > 0);
}

/** Every physical line from a `  <key>:` header (2-space indent — one of
 *  `ships_with:`'s direct children) up to, but not including, the next line
 *  at that same 2-space indent (the next sibling key, or end of block). A
 *  4+-space-indented continuation (a wrapped flow list, or a nested `- name:`
 *  hook entry) is never mistaken for a sibling key. */
function sliceTopKey(lines: string[], key: string): string[] | null {
	const start = lines.findIndex((l) => new RegExp(`^  ${key}:`).test(l));
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^ {2}\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end);
}

function parseAgents(lines: string[]): string[] {
	const body = sliceTopKey(lines, "agents");
	if (!body) return [];
	const joined = body.join(" ");
	return parseFlowList(joined.slice(joined.indexOf(":") + 1));
}

function parseHooks(lines: string[]): ParsedHook[] {
	const body = sliceTopKey(lines, "hooks");
	if (!body) return [];
	const entries = body.slice(1); // drop the "  hooks:" header line
	const starts: number[] = [];
	entries.forEach((l, i) => {
		if (/^\s*-\s*name:/.test(l)) starts.push(i);
	});
	const field = (entryLines: string[], name: string): string => {
		const line = entryLines.find((l) => new RegExp(`^\\s*(?:-\\s*)?${name}:`).test(l));
		if (!line) return "";
		return line
			.slice(line.indexOf(`${name}:`) + name.length + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	};
	return starts.map((s, i) => {
		const e = i + 1 < starts.length ? starts[i + 1] : entries.length;
		const entryLines = entries.slice(s, e);
		return {
			name: field(entryLines, "name"),
			event: field(entryLines, "event"),
			command: field(entryLines, "command"),
			activation: field(entryLines, "activation"),
			tools: parseFlowList(field(entryLines, "tools")),
		};
	});
}

function parsePermissions(lines: string[]): { allow: string[]; deny: string[]; ask: string[] } {
	const body = sliceTopKey(lines, "permissions");
	const out = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };
	if (!body) return out;
	for (const kind of ["allow", "deny", "ask"] as const) {
		const line = body.find((l) => new RegExp(`^\\s*${kind}:`).test(l));
		if (line) out[kind] = parseFlowList(line.slice(line.indexOf(":") + 1));
	}
	return out;
}

function parseShipsWithBlock(block: string): ParsedShipsWith {
	const lines = block.split("\n");
	return {
		agents: parseAgents(lines),
		hooks: parseHooks(lines),
		permissions: parsePermissions(lines),
	};
}

describe("companions fixture parity (C9)", () => {
	it("the mock registry declares orchestrate-advanced.ships_with", () => {
		const sw = registry.skills["orchestrate-advanced"]?.ships_with;
		expect(sw, "mock registry must carry skills['orchestrate-advanced'].ships_with").toBeTruthy();
	});

	it("matches the real fixture's ships_with block in both directions (W-7)", () => {
		const skillMd = readFileSync(FIXTURE_PATH, "utf-8");
		const block = extractShipsWithBlock(skillMd);
		const fixture = parseShipsWithBlock(block);
		const sw = registry.skills["orchestrate-advanced"]?.ships_with;
		expect(sw).toBeTruthy();

		// Agents: sorted-array equality catches an added/removed/renamed name in
		// EITHER direction (a plain Set would silently swallow a duplicate).
		expect([...(sw!.agents ?? [])].sort()).toEqual([...fixture.agents].sort());

		// Hooks: same name-set both ways, then every field (event/command/
		// activation/tools) compared per hook — not just the name.
		const mockHookNames = (sw!.hooks ?? []).map((h) => h.name).sort();
		const fixtureHookNames = fixture.hooks.map((h) => h.name).sort();
		expect(mockHookNames).toEqual(fixtureHookNames);
		expect(mockHookNames.length).toBeGreaterThan(0);

		const fixtureHooksByName = new Map(fixture.hooks.map((h) => [h.name, h]));
		for (const mockHook of sw!.hooks ?? []) {
			const fixtureHook = fixtureHooksByName.get(mockHook.name);
			expect(fixtureHook, `fixture is missing hook '${mockHook.name}'`).toBeTruthy();
			// A18/C5: parity asserts the DECLARED block only, keyed on `name` —
			// a ref hook's event/command/activation/tools live in the hooks
			// library, not the frontmatter's `ships_with` block, so there is
			// nothing else to compare for one here.
			if (isHookRef(mockHook)) continue;
			expect({
				event: mockHook.event,
				command: mockHook.command,
				activation: mockHook.activation,
				tools: [...(mockHook.tools ?? [])].sort(),
			}).toEqual({
				event: fixtureHook!.event,
				command: fixtureHook!.command,
				activation: fixtureHook!.activation,
				tools: [...fixtureHook!.tools].sort(),
			});
		}
		// A1: every hook is `while-running` — no `harnesses:` key (plan 3, on
		// purpose: the fixture must produce real per-harness verdict rows for I2).
		// A ref hook carries neither field inline, so it vacuously satisfies both.
		expect(sw!.hooks?.every((h) => isHookRef(h) || h.activation === "while-running")).toBe(
			true,
		);
		expect(
			sw!.hooks?.every((h) => isHookRef(h) || !h.harnesses || h.harnesses.length === 0),
		).toBe(true);

		// Permissions: every rule kind, both directions (A8's two loop-safe rows).
		for (const kind of ["allow", "deny", "ask"] as const) {
			expect([...(sw!.permissions?.[kind] ?? [])].sort()).toEqual(
				[...fixture.permissions[kind]].sort(),
			);
		}
		expect(fixture.permissions.deny).toEqual(["Bash(git push --force:*)"]);
		expect(fixture.permissions.ask).toEqual(["Bash(gh pr merge:*)"]);
	});
});
