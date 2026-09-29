// Guards for the per-PR preview deployment (app/vercel.json).
//
// Vercel builds the frontend from the `app` root directory and serves it as a
// static site. The build MUST run with VISUAL_MOCK=1: that is the one switch
// (vite.config.ts) that swaps the Tauri IPC modules for src/mocks/, and without
// it the bundle would boot against a Tauri bridge that does not exist in a
// browser. These tests pin the three pieces of that contract so a rename in
// package.json or vercel.json cannot silently ship a preview that renders the
// Python-missing gate instead of the app.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(__dirname, "../..");
const vercel = JSON.parse(fs.readFileSync(path.join(appDir, "vercel.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
// website/ is export-ignored (see .gitattributes): on the public snapshot the
// landing page's vercel.json is absent, so every check here is skipped there.
const websiteVercelPath = path.join(appDir, "../website/vercel.json");
const websiteMissing = !fs.existsSync(websiteVercelPath);
const websiteVercel = websiteMissing ? null : JSON.parse(fs.readFileSync(websiteVercelPath, "utf8"));

// skipIf reason: website/vercel.json is private evidence not shipped.
describe.skipIf(websiteMissing)("PR preview (vercel.json)", () => {
	it("builds through an npm script that exists", () => {
		const m = /^npm run (\S+)$/.exec(vercel.buildCommand);
		expect(m, "buildCommand must be `npm run <script>`").not.toBeNull();
		expect(pkg.scripts).toHaveProperty(m![1]);
	});

	it("the build script turns the Tauri mock on", () => {
		const script = pkg.scripts["build:preview"] as string;
		expect(script).toMatch(/^VISUAL_MOCK=1 vite build\b/);
	});

	it("serves vite's default output directory", () => {
		expect(vercel.outputDirectory).toBe("dist");
	});

	it("skips builds for commits that do not touch app/", () => {
		// Exit 0 from the ignore command = skip. Same rule as website/vercel.json.
		expect(vercel.ignoreCommand).toBe("git diff --quiet HEAD^ HEAD ./");
	});

	it("does not let Vercel guess a framework preset", () => {
		// A preset would override buildCommand/outputDirectory.
		expect(vercel.framework).toBeNull();
	});
});

// The ignore step (above) runs AFTER Vercel has already created a deployment
// record — Vercel's own project-settings doc: "Canceled builds are counted
// as full deployments as they execute a build command in the build step.
// This means that any canceled builds initiated using the ignore build step
// will still count towards your deployment quotas". Only git.deploymentEnabled
// stops a record from being created at all, which is what keeps both Vercel
// projects under the Hobby plan's 100-deployments-per-day limit.
describe.skipIf(websiteMissing)("git.deploymentEnabled (deployment record gating)", () => {
	it("app preview never deploys pr-assets/*, backup/*, or main", () => {
		// pr-assets/**, backup/**: screenshot-proof and backup branches never
		// carry app/ changes. main: the PR preview already covered the merge.
		expect(vercel.git.deploymentEnabled).toEqual({
			"pr-assets/**": false,
			"backup/**": false,
			"main": false,
		});
	});

	it("website deploys only main and website work branches", () => {
		// Production stays on main; landing-page work uses <type>/website-<topic>
		// (not website/** — that collides with the website/ directory itself).
		expect(websiteVercel.git.deploymentEnabled).toEqual({
			"**": false,
			"main": true,
			"*/website-*": true,
		});
	});

	it("both projects still skip the build for unrelated commits on branches that do deploy", () => {
		expect(vercel.ignoreCommand).toBe("git diff --quiet HEAD^ HEAD ./");
		expect(websiteVercel.ignoreCommand).toBe("git diff --quiet HEAD^ HEAD ./");
	});
});
