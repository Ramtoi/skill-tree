// Guards for the visual harness's env parsing (visual/config.mjs) and the
// pr-proof helpers (visual/proof-lib.mjs). Both modules are pure so they run
// here without Playwright; the browser-driving scripts stay untested on
// purpose (they are exercised by running `npm run visual:pr`).
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SCENES } from "../../visual/capture.mjs";
import {
	DEFAULT_WIDTHS,
	OUT_SENTINEL,
	canWipe,
	clipRect,
	frameName as frameNameConfig,
	resolveAppDir,
	resolveClip,
	resolveDevPort,
	resolveOnly,
	resolveOutDir,
	resolveWidths,
} from "../../visual/config.mjs";
import {
	MARK_END,
	MARK_START,
	VERCEL_GATING_FILES,
	assetBranchAllowed,
	assetUrl,
	frameName,
	oneScenePerSection,
	pairHtml,
	pairName,
	parseArgs,
	repoSlugFromRemote,
	routeOf,
	screenshotsMarkdown,
	sectionForPath as sectionForPathMjs,
	selectScenes,
	spliceBody,
} from "../../visual/proof-lib.mjs";
import { sectionForPath } from "@/lib/sections";

const silent = () => {};

describe("visual/config.mjs env parsing", () => {
	it("ST_DEV_PORT: default, valid, junk → fallback with warning", () => {
		const warn = vi.fn();
		expect(resolveDevPort({}, warn)).toBe(1420);
		expect(resolveDevPort({ ST_DEV_PORT: "1478" }, warn)).toBe(1478);
		expect(resolveDevPort({ ST_DEV_PORT: "abc" }, warn)).toBe(1420);
		expect(resolveDevPort({ ST_DEV_PORT: "70000" }, warn)).toBe(1420);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("ST_VISUAL_WIDTHS: default list, ordered + deduped, junk → fallback", () => {
		const warn = vi.fn();
		expect(resolveWidths({}, warn)).toEqual(DEFAULT_WIDTHS);
		expect(resolveWidths({ ST_VISUAL_WIDTHS: "1440, 520,1440" }, warn)).toEqual([1440, 520]);
		expect(resolveWidths({ ST_VISUAL_WIDTHS: "1440,tiny" }, warn)).toEqual(DEFAULT_WIDTHS);
		expect(resolveWidths({ ST_VISUAL_WIDTHS: "100" }, warn)).toEqual(DEFAULT_WIDTHS);
		expect(warn).toHaveBeenCalledTimes(2);
		// The fallback must be a copy — callers mutate nothing shared.
		expect(resolveWidths({}, warn)).not.toBe(DEFAULT_WIDTHS);
	});

	it("ST_VISUAL_ONLY: empty → [], trims + drops blanks", () => {
		expect(resolveOnly({})).toEqual([]);
		expect(resolveOnly({ ST_VISUAL_ONLY: " a, ,b " })).toEqual(["a", "b"]);
	});

	it("ST_VISUAL_CLIP: selector, selector:height, pseudo-selectors intact, junk → null", () => {
		expect(resolveClip({}, silent)).toBeNull();
		expect(resolveClip({ ST_VISUAL_CLIP: ".app-main" }, silent)).toEqual({ selector: ".app-main", height: null });
		expect(resolveClip({ ST_VISUAL_CLIP: ".app-main:160" }, silent)).toEqual({ selector: ".app-main", height: 160 });
		expect(resolveClip({ ST_VISUAL_CLIP: "a:nth-child(2)" }, silent)).toEqual({ selector: "a:nth-child(2)", height: null });
		expect(resolveClip({ ST_VISUAL_CLIP: ":160" }, silent)).toBeNull();
		expect(resolveClip({ ST_VISUAL_CLIP: ".x:0" }, silent)).toBeNull();
	});

	it("ST_VISUAL_OUT / ST_VISUAL_APP: defaults, relative resolves against cwd", () => {
		expect(resolveOutDir({}, "/v")).toBe(path.join("/v", "out"));
		expect(resolveOutDir({ ST_VISUAL_OUT: "proof/before" }, "/v", "/cwd")).toBe("/cwd/proof/before");
		expect(resolveOutDir({ ST_VISUAL_OUT: "/abs" }, "/v", "/cwd")).toBe("/abs");
		expect(resolveAppDir({}, "/app")).toBe("/app");
		expect(resolveAppDir({ ST_VISUAL_APP: "../other/app" }, "/app", "/cwd/x")).toBe("/cwd/other/app");
	});
});

describe("visual/config.mjs geometry + wipe guard", () => {
	it("clipRect intersects the element box with the viewport", () => {
		expect(clipRect({ x: 296, y: 0, width: 1144, height: 900 }, 1440, 900, 160)).toEqual({ x: 296, y: 0, width: 1144, height: 160 });
		// Forced height beyond the viewport bottom is cut at the viewport.
		expect(clipRect({ x: 0, y: 800, width: 500, height: 50 }, 1440, 900, 400)).toEqual({ x: 0, y: 800, width: 500, height: 100 });
		// Element partly scrolled above the fold: only the visible part, from y=0.
		expect(clipRect({ x: 10, y: -40, width: 100, height: 100 }, 1440, 900)).toEqual({ x: 10, y: 0, width: 100, height: 60 });
		// Wider than the viewport: cut at the right edge.
		expect(clipRect({ x: 1400, y: 0, width: 200, height: 10 }, 1440, 900)).toEqual({ x: 1400, y: 0, width: 40, height: 10 });
		// Fully off-screen or absent → null.
		expect(clipRect({ x: 1500, y: 0, width: 10, height: 10 }, 1440, 900)).toBeNull();
		expect(clipRect({ x: 0, y: -50, width: 10, height: 40 }, 1440, 900)).toBeNull();
		expect(clipRect(null, 1440, 900)).toBeNull();
	});

	it("canWipe: missing or empty dirs and sentinel-marked dirs only", () => {
		expect(canWipe(null)).toBe(true);
		expect(canWipe([])).toBe(true);
		expect(canWipe([OUT_SENTINEL, "a.png"])).toBe(true);
		// A checkout, a home dir, anything without the sentinel: refuse.
		expect(canWipe(["src", "node_modules", "package.json"])).toBe(false);
		expect(canWipe(["a.png"])).toBe(false);
	});

	it("frameName is one template shared by capture and pr-proof", () => {
		expect(frameName).toBe(frameNameConfig);
		expect(frameName("skill-library", 1440)).toBe("skill-library__1440.png");
	});
});

describe("capture.mjs is importable", () => {
	it("exports a non-empty SCENES list with unique ids and hash routes (a query may precede the hash)", () => {
		expect(SCENES.length).toBeGreaterThan(50);
		const ids = SCENES.map((s: { id: string }) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of SCENES as { id: string; path: string }[]) {
			expect(s.path, s.id).toMatch(/^\/(\?[^#]*)?#\//);
		}
	});
});

describe("capture.mjs as an entrypoint", () => {
	it("runs main() when executed directly (ST_VISUAL_LIST=1 lists scenes and exits before Vite)", () => {
		const script = path.resolve(__dirname, "../../visual/capture.mjs");
		const out = execFileSync(process.execPath, [script], {
			cwd: path.resolve(__dirname, "../.."),
			env: { ...process.env, ST_VISUAL_LIST: "1" },
			encoding: "utf8",
			timeout: 20000,
		});
		const ids = out.trim().split("\n");
		expect(ids).toEqual((SCENES as { id: string }[]).map((s) => s.id));
	}, 30000);
});

describe("proof-lib: sections", () => {
	it("routeOf strips the hash prefix and any query", () => {
		expect(routeOf("/#/")).toBe("/");
		expect(routeOf("/#/project/x?tab=1")).toBe("/project/x");
		expect(routeOf("/#/?new=1")).toBe("/");
	});

	it("the .mjs port of sectionForPath agrees with lib/sections.ts on every scene route", () => {
		const routes = new Set<string>([
			"/", "/skill/x", "/bundle/x", "/project/x", "/sources", "/sources/y", "/snippets",
			"/hooks", "/hook/new", "/permissions", "/harnesses", "/harness/claude-code",
			"/remotes", "/remote/r", "/cloud/claude-ai", "/usage", "/backup", "/nope",
			...(SCENES as { path: string }[]).map((s) => routeOf(s.path)),
		]);
		for (const r of routes) expect(sectionForPathMjs(r), r).toBe(sectionForPath(r));
	});

	it("oneScenePerSection keeps the first scene of each section, in order", () => {
		const scenes = [
			{ id: "a", path: "/#/" },
			{ id: "b", path: "/#/skill/x" },
			{ id: "c", path: "/#/sources" },
			{ id: "d", path: "/#/project/p" },
			{ id: "e", path: "/#/sources/s" },
		];
		expect(oneScenePerSection(scenes).map((s: { id: string }) => s.id)).toEqual(["a", "c", "d"]);
	});
});

describe("proof-lib: parseArgs", () => {
	const base = { cwd: "/cwd", defaultAppDir: "/cwd/app", defaultOut: "/cwd/app/visual/proof" };

	it("requires --scenes or --all", () => {
		expect(parseArgs([], base)).toMatchObject({ ok: false });
		expect(parseArgs(["--all"], base)).toMatchObject({ ok: true, opts: { all: true } });
		expect(parseArgs(["--scenes", "a,b"], base)).toMatchObject({ ok: true, opts: { scenes: ["a", "b"] } });
		expect(parseArgs(["--all", "--scenes", "a"], base)).toMatchObject({ ok: false });
	});

	it("resolves dirs against cwd and keeps defaults", () => {
		const r = parseArgs(["--scenes", "a", "--before", "../other/app", "--out", "o"], base);
		expect(r.ok).toBe(true);
		expect(r.opts.before).toBe("/other/app");
		expect(r.opts.after).toBe("/cwd/app");
		expect(r.opts.out).toBe("/cwd/o");
		expect(r.opts.widths).toEqual([1440]);
		expect(r.opts.portBase).toBe(1461);
	});

	it("rejects repeated flags, empty values, and values that look like flags", () => {
		expect(parseArgs(["--scenes", "a", "--scenes", "b"], base)).toMatchObject({ ok: false, error: "--scenes given twice" });
		expect(parseArgs(["--scenes", "a", "--clip", ""], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "a", "--out", "-foo"], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "a", "--allow-missing"], base)).toMatchObject({ ok: true, opts: { allowMissing: true } });
	});

	it("validates widths, ports, pr, and value-less flags", () => {
		expect(parseArgs(["--scenes", "a", "--widths", "1440,x"], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "a", "--widths", "1440,520,1440"], base).opts?.widths).toEqual([1440, 520]);
		expect(parseArgs(["--scenes", "a", "--port-base", "80"], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "a", "--pr", "0"], base).ok).toBe(false);
		expect(parseArgs(["--scenes"], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "--all"], base).ok).toBe(false);
		expect(parseArgs(["--bogus"], base).ok).toBe(false);
	});

	it("--pr needs --publish; --publish must live under pr-assets/", () => {
		expect(parseArgs(["--scenes", "a", "--pr", "52"], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "a", "--publish", "master"], base).ok).toBe(false);
		expect(parseArgs(["--scenes", "a", "--publish", "pr-assets/x", "--pr", "52"], base)).toMatchObject({
			ok: true,
			opts: { publish: "pr-assets/x", pr: 52 },
		});
	});

	it("--help wins even next to an unknown argument", () => {
		expect(parseArgs(["-h"], base)).toMatchObject({ ok: true, opts: { help: true } });
		expect(parseArgs(["--bogus", "--help"], base)).toMatchObject({ ok: true, opts: { help: true } });
	});
});

describe("proof-lib: vercel deploy gating", () => {
	it("disables git deployments for both Vercel projects in the pr-assets commit", () => {
		// The orphan commit pr-proof.mjs pushes has no app/ or website/ Root
		// Directory of its own, so the real vercel.json files' pr-assets rules
		// never apply to it — these two disable the record outright.
		expect(VERCEL_GATING_FILES).toEqual([
			{ path: "app/vercel.json", content: '{"git":{"deploymentEnabled":false}}\n' },
			{ path: "website/vercel.json", content: '{"git":{"deploymentEnabled":false}}\n' },
		]);
		for (const f of VERCEL_GATING_FILES) {
			expect(JSON.parse(f.content)).toEqual({ git: { deploymentEnabled: false } });
		}
	});
});

describe("proof-lib: asset branch guard", () => {
	it("accepts only a non-empty, path-safe pr-assets/* name", () => {
		expect(assetBranchAllowed("pr-assets/unified-headers")).toBe(true);
		expect(assetBranchAllowed("pr-assets/a/b.1")).toBe(true);
		expect(assetBranchAllowed("pr-assets/")).toBe(false);
		expect(assetBranchAllowed("pr-assets/../master")).toBe(false);
		expect(assetBranchAllowed("pr-assets/x/")).toBe(false);
		expect(assetBranchAllowed("pr-assets/x y")).toBe(false);
		expect(assetBranchAllowed("master")).toBe(false);
		expect(assetBranchAllowed("feat/pr-assets/x")).toBe(false);
	});
});

describe("proof-lib: scene selection + names", () => {
	const scenes = [{ id: "a" }, { id: "b" }, { id: "c" }];
	it("keeps caller order and rejects unknown ids", () => {
		expect(selectScenes(scenes, { ids: ["c", "a"], all: false })).toEqual({ ok: true, scenes: [{ id: "c" }, { id: "a" }] });
		expect(selectScenes(scenes, { ids: ["a", "zz", "yy"], all: false })).toEqual({ ok: false, error: "unknown scene id(s): zz, yy" });
		expect(selectScenes(scenes, { ids: [], all: true }).scenes).toHaveLength(3);
	});
	it("pairName: primary width has no suffix", () => {
		expect(pairName("x", 1440, 1440)).toBe("x.png");
		expect(pairName("x", 520, 1440)).toBe("x__520.png");
	});
});

describe("proof-lib: sheet html", () => {
	const img = { src: "data:image/png;base64,AAAA", cssWidth: 1144 };
	it("before+after stacks two captioned images, caps width", () => {
		const h = pairHtml("s", { before: img, after: { ...img, cssWidth: 5000 }, hasBeforeSide: true, maxWidth: 1200 });
		expect(h).toContain('id="pair-s"');
		expect(h).toContain(">before<");
		expect(h).toContain(">after<");
		expect(h).toContain('width="1144"');
		expect(h).toContain('width="1200"');
	});
	it("marks a missing before as a new scene and a missing after as failed", () => {
		expect(pairHtml("s", { before: null, after: img, hasBeforeSide: true, maxWidth: 1200 })).toContain("no BEFORE");
		expect(pairHtml("s", { before: img, after: null, hasBeforeSide: true, maxWidth: 1200 })).toContain("capture failed");
		expect(pairHtml("s", { before: null, after: img, hasBeforeSide: false, maxWidth: 1200 })).not.toContain("no BEFORE");
	});
	it("escapes ids", () => {
		expect(pairHtml('a"<b', { before: null, after: img, hasBeforeSide: false, maxWidth: 1200 })).not.toContain('a"<b');
	});
	it("flags a clip miss and a width mismatch on the sheet", () => {
		const h = pairHtml("s", { before: { ...img, cssWidth: 1440, unclipped: true }, after: img, hasBeforeSide: true, maxWidth: 1200 });
		expect(h).toContain("clip missed");
		expect(h).toContain("widths differ: 1440 vs 1144px");
	});
});

describe("proof-lib: PR markdown + splice", () => {
	const entries = [
		{ id: "skill-library", pairs: [{ width: 1440, file: "skill-library.png" }, { width: 520, file: "skill-library__520.png" }] },
		{ id: "sources", pairs: [{ width: 1440, file: "sources.png" }] },
	];

	it("assetUrl uses blob/<ref>/…?raw=true (renders inline on a private repo; ref = the pushed commit)", () => {
		expect(assetUrl("o/r", "pr-assets/x", "pairs/a.png")).toBe("https://github.com/o/r/blob/pr-assets/x/pairs/a.png?raw=true");
		expect(assetUrl("o/r", "caad1c1fe869afff52caed894c8c9743f1c0f86e", "pairs/a.png")).toBe(
			"https://github.com/o/r/blob/caad1c1fe869afff52caed894c8c9743f1c0f86e/pairs/a.png?raw=true",
		);
	});

	it("repoSlugFromRemote handles https + ssh, with and without .git, and only github.com itself", () => {
		expect(repoSlugFromRemote("https://github.com/acme-corp/citrus-app.git")).toBe("acme-corp/citrus-app");
		expect(repoSlugFromRemote("git@github.com:acme-corp/citrus-app.git\n")).toBe("acme-corp/citrus-app");
		expect(repoSlugFromRemote("ssh://git@github.com/o/r.git")).toBe("o/r");
		expect(repoSlugFromRemote("https://github.com/o/r/")).toBe("o/r");
		expect(repoSlugFromRemote("https://gitlab.com/o/r")).toBeNull();
		expect(repoSlugFromRemote("https://mygithub.com/o/r")).toBeNull();
		expect(repoSlugFromRemote("https://github.company.com/o/r")).toBeNull();
	});

	it("escapes the image src, not only alt", () => {
		const md = screenshotsMarkdown({ title: "T", base: (r: string) => `x"><b>${r}`, entries: [entries[1]], showSections: false, hasBefore: false, primaryWidth: 1440, branch: null });
		expect(md).not.toContain('x"><b>');
		expect(md).toContain("x&quot;&gt;&lt;b&gt;pairs/sources.png");
	});

	it("wraps in markers, opens primary pairs, folds other widths, names the branch", () => {
		const md = screenshotsMarkdown({
			title: "Screens",
			base: (rel: string) => `U/${rel}`,
			entries,
			showSections: true,
			hasBefore: true,
			primaryWidth: 1440,
			branch: "pr-assets/x",
		});
		expect(md.startsWith(MARK_START)).toBe(true);
		expect(md.trimEnd().endsWith(MARK_END)).toBe(true);
		expect(md).toContain("## Screens");
		expect(md).toContain('src="U/sheets/after-sections.png"');
		expect(md).toContain("<details open><summary><code>skill-library</code></summary>");
		expect(md).toContain('src="U/pairs/skill-library.png"');
		expect(md).toContain("### Other widths");
		expect(md).toContain("<details><summary><code>skill-library</code> @520px</summary>");
		expect(md).toContain('src="U/pairs/skill-library__520.png"');
		expect(md).toContain("`pr-assets/x`");
		expect(md).toContain("Before → after");
	});

	it("after-only proof without sections omits those parts", () => {
		const md = screenshotsMarkdown({ title: "T", base: (r: string) => r, entries: [entries[1]], showSections: false, hasBefore: false, primaryWidth: 1440, branch: null });
		expect(md).not.toContain("after-sections.png");
		expect(md).not.toContain("Other widths");
		expect(md).not.toContain("orphan branch");
		expect(md).toContain("### After @1440px");
	});

	it("spliceBody replaces an existing marker block and otherwise appends", () => {
		const snippet = `${MARK_START}\nNEW\n${MARK_END}\n`;
		const body = `## Why\n\nstuff\n\n${MARK_START}\nOLD\n${MARK_END}\n\n## After\n`;
		const out = spliceBody(body, snippet);
		expect(out).toContain("NEW");
		expect(out).not.toContain("OLD");
		expect(out).toContain("## After");
		expect(out.indexOf(MARK_START)).toBe(out.lastIndexOf(MARK_START));

		const appended = spliceBody("## Why\n\nstuff\n\n", snippet);
		expect(appended).toBe(`## Why\n\nstuff\n\n${MARK_START}\nNEW\n${MARK_END}\n`);
		expect(spliceBody("", snippet)).toBe(`${MARK_START}\nNEW\n${MARK_END}\n`);
		expect(spliceBody(null as unknown as string, snippet)).toBe(`${MARK_START}\nNEW\n${MARK_END}\n`);
	});

	it("spliceBody refuses duplicated, unbalanced, or reversed markers instead of growing the body", () => {
		const snippet = `${MARK_START}\nNEW\n${MARK_END}\n`;
		expect(() => spliceBody(`${MARK_START}\nA\n${MARK_END}\n${MARK_START}\nB\n${MARK_END}`, snippet)).toThrow(/2 start/);
		expect(() => spliceBody(`${MARK_END}\nX\n${MARK_START}`, snippet)).toThrow(/before the start/);
		expect(() => spliceBody(`${MARK_START}\nX`, snippet)).toThrow(/1 start \/ 0 end/);
	});
});
