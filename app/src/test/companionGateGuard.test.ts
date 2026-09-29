import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── Companion consequence gate guard (I1/A4, C8) ─────────────────────────
//
// `hub enable <skill> --project <p>` on a skill with a non-empty `ships_with`
// gates on a consequence dialog unless `--with-companions`/`--skill-only` is
// already known (D2). Exactly two files may run `enable` with `"enable"` as
// the FIRST element of an args array without going through that gate:
//
//   - `hooks/useCompanionGate.tsx` — the gate itself (`equipWithGate`), the
//     ONE place the gated call and its `--with-companions` re-run happen.
//   - `hooks/useEquip.ts` — `equipSkillRefsOnly`, the ONE ref-equip helper
//     (grill B2/W7): a toast/banner action must never raise a modal, so a
//     ref-equip always passes `--skill-only` and every OTHER ref-equip call
//     site (`ProjectLoadoutView.tsx`'s missing-refs banner) imports this
//     shared helper rather than building its own raw call.
//
// Modelled on `test/ipcImportGuard.test.ts` / `test/hubCmdGuard.test.ts`. A
// seventh call site — any other file that builds `["enable", ...]` itself —
// fails this suite instead of silently bypassing consent.

const SRC = join(process.cwd(), "src");

const ALLOW = [
	join("hooks", "useCompanionGate.tsx"),
	join("hooks", "useEquip.ts"),
	"test" + sep,
	"mocks" + sep,
];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
	}
	return out;
}

function isAllowed(relPath: string): boolean {
	return ALLOW.some((a) => (a.endsWith(sep) ? relPath.startsWith(a) : relPath === a));
}

/** R12 (milestone 6 review): a plain regex text-scan can't tell a real call
 *  from a JSDoc/line-comment MENTION of the same words (e.g.
 *  `useCompanionGate.tsx`'s own doc comment says `` `equip()` promise ``) —
 *  stripped here so neither pattern below can ever match across a comment
 *  boundary into unrelated real code that happens to say `force:` later in
 *  the same file. Good-enough for this guard's purposes (same class as its
 *  other regexes) — not a full parser, and never applied to the literal-
 *  string unit tests below, only to real file scans. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Matches an `"enable"` string literal as the first element of an array
 *  literal passed to `runHubCmd(`, `hubCmd(`, or `runWithGate<...>(` — the
 *  three ways a call site can spawn `hub enable`. `[A-Za-z0-9_]*` before the
 *  base name tolerates ANY identifier ending in one of them — not just the
 *  bare name — so an import alias (`ProjectWorkspace.tsx`'s
 *  `runHubCmd as sharedRunHubCmd`) is caught too: `sharedRunHubCmd(` matches
 *  via the `shared` prefix + `[rR]unHubCmd` (capitalised mid-identifier).
 *  (Review W-5: the previous case-sensitive, prefix-free pattern missed
 *  `sharedRunHubCmd(["enable", …])` — verified failing before this fix,
 *  passing after.) */
const RAW_ENABLE_CALL =
	/(?:^|[^a-zA-Z0-9_])[A-Za-z0-9_]*(?:[rR]unHubCmd|hubCmd|runWithGate)(?:<[^>]*>)?\(\s*\[\s*["']enable["']/;

/** Matches a `force:` option passed to `equipWithGate(...)` / `gate.equip(...)`
 *  — the ONE call site allowed to pass it is `ProjectWorkspace.tsx`'s
 *  disable-undo replay (C8: it must replay exactly what `hub disable` already
 *  removed, never guess). Every OTHER `Provision`/equip affordance (A22/C1) —
 *  including wave D's Loadout banner — calls the gate with NO `force`: the
 *  consequence dialog IS the consent. `[^;]*?` keeps the match to one
 *  statement (lazy, no semicolon crossed) so an unrelated later `force:` in
 *  the same file (several files use that word for an unrelated flag, e.g.
 *  `RemotesScreen.tsx`, `useSnippets.ts`) is never swept in — the match must
 *  start at the gate call itself.
 *
 *  R12 (milestone 6 review): the original pattern matched only the two
 *  literal spellings `gate.equip(`/`equipWithGate(`, so `hooks/useEquip.ts`'s
 *  `const { equip } = useCompanionGate(); … equip(skillName, project)` — the
 *  gate's `equipWithGate` under a destructured LOCAL name — was invisible: a
 *  future `equip(skillName, project, { force: "with" })` there would pass
 *  this guard silently. `\bequip\(` (no whitespace tolerance — a real call
 *  is always `equip(`, never `equip (`, which only a comment/prose aside
 *  writes) adds that spelling without also matching `equipRefs(`/
 *  `equipSkillRefsOnly(` (the `\(` must follow the bare word immediately).
 *  Every file scan below strips comments first (`stripComments`) so this
 *  broader alternative can't fire on a JSDoc mention of `` `equip()` ``. */
const FORCE_OPTION_ON_GATE_CALL =
	/(?:gate\.equip|equipWithGate|\bequip)\([^;]*?\bforce\s*:/;

const FORCE_ALLOW = [join("screens", "ProjectWorkspace.tsx")];

describe("companion consequence gate guard", () => {
	const files = walk(SRC);

	it("no file outside the gate + the ref-equip helper builds a raw `[\"enable\", …]` call", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const rel = relative(SRC, file);
			if (isAllowed(rel)) continue;
			if (RAW_ENABLE_CALL.test(readFileSync(file, "utf-8"))) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	it("the gate itself and the ref-equip helper both still run 'enable' directly", () => {
		const gate = readFileSync(join(SRC, "hooks", "useCompanionGate.tsx"), "utf-8");
		expect(RAW_ENABLE_CALL.test(gate)).toBe(true);
		const refs = readFileSync(join(SRC, "hooks", "useEquip.ts"), "utf-8");
		expect(RAW_ENABLE_CALL.test(refs)).toBe(true);
	});

	// Review W-5: the pattern must catch a call through an import ALIAS, not
	// just the bare name — `ProjectWorkspace.tsx` imports
	// `runHubCmd as sharedRunHubCmd`, and any future call site that reaches
	// for that alias directly (instead of the local wrapper/the gate) must
	// still be caught.
	it("matches a raw enable call through the sharedRunHubCmd import alias", () => {
		expect(RAW_ENABLE_CALL.test('sharedRunHubCmd(["enable", skillName])')).toBe(true);
		expect(
			RAW_ENABLE_CALL.test('await sharedRunHubCmd(["enable", skillName, "--project", p]);'),
		).toBe(true);
	});

	// A22/C1 (wave 2): every `Provision` affordance — the section's rung, the
	// save toast, and wave D's Loadout banner — calls the gate with NO
	// `force`. Only `ProjectWorkspace.tsx`'s disable-undo replay knows which
	// choice to replay and is allowed to pass it.
	it("no call site outside ProjectWorkspace's disable-undo replay passes `force` to the gate", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const rel = relative(SRC, file);
			if (rel.startsWith("test" + sep) || rel.startsWith("mocks" + sep)) continue;
			if (FORCE_ALLOW.includes(rel)) continue;
			if (FORCE_OPTION_ON_GATE_CALL.test(stripComments(readFileSync(file, "utf-8")))) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});

	// R12: `useEquip.ts`'s `equip(...)` (the gate's `equipWithGate` under a
	// destructured local name) is DELIBERATELY NOT in `FORCE_ALLOW` — it must
	// stay force-free like every other call site, and the guard above must be
	// ABLE to catch it if that ever changes. Proven two ways: the broadened
	// pattern matches the real spelling with a hypothetical `force:` added,
	// and the guard reports zero offenders against the file'S ACTUAL content
	// today (no false positive from the `equip()` mention in
	// `useCompanionGate.tsx`'s doc comment, once comments are stripped).
	it("would catch useEquip.ts's destructured equip(...) call if it ever passed force", () => {
		expect(
			FORCE_OPTION_ON_GATE_CALL.test(
				'const { equip } = useCompanionGate();\nawait equip(skillName, project, { force: "with" });',
			),
		).toBe(true);
	});

	it("does not false-positive on useCompanionGate.tsx's own `equip()` doc-comment mention", () => {
		const content = readFileSync(join(SRC, "hooks", "useCompanionGate.tsx"), "utf-8");
		expect(FORCE_OPTION_ON_GATE_CALL.test(stripComments(content))).toBe(false);
	});

	it("ProjectWorkspace's disable-undo replay still passes force, replaying what was removed", () => {
		const content = readFileSync(join(SRC, "screens", "ProjectWorkspace.tsx"), "utf-8");
		expect(FORCE_OPTION_ON_GATE_CALL.test(content)).toBe(true);
	});

	it("the pattern does not false-positive on an unrelated `force:` field in the same file", () => {
		expect(
			FORCE_OPTION_ON_GATE_CALL.test(
				'async function pushDoc(force: boolean) { await x({ force: false }); }',
			),
		).toBe(false);
		expect(
			FORCE_OPTION_ON_GATE_CALL.test(
				'gate.equip(skillName, projectName!);\nasync function other(force: boolean) {}',
			),
		).toBe(false);
		// R12: the bare `\bequip\(` alternative must not fire on `equipRefs(`/
		// `equipSkillRefsOnly(` (a different word, `equip` isn't immediately
		// followed by `(`) even when a `force:` field appears nearby.
		expect(
			FORCE_OPTION_ON_GATE_CALL.test(
				'await equipSkillRefsOnly(rec.skill, projectName, { force: false });',
			),
		).toBe(false);
	});

	it("matches gate.equip(...) / equipWithGate(...) calls that DO pass force", () => {
		expect(
			FORCE_OPTION_ON_GATE_CALL.test(
				'await gate.equip(skillName, projectName!, { force: hadCompanions ? "with" : "only" })',
			),
		).toBe(true);
		expect(
			FORCE_OPTION_ON_GATE_CALL.test(
				'await equipWithGate(skillName, projectName, { force: "with" })',
			),
		).toBe(true);
	});
});
