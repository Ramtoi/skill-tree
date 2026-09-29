import { describe, it, expect } from "vitest";
import { waitFor, within } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import type { QueryClient } from "@tanstack/react-query";

import {
	renderWithProviders,
	makeQueryClient,
	sampleRegistry,
	mockCommands,
	hang,
	fail,
	hubFail,
	type CommandTable,
} from "./helpers";
import { defaultImpl as defaultInvokeImpl } from "./setup";
import { useAppStore, type HarnessStatus } from "@/store";

import { SkillLibrary } from "@/screens/SkillLibrary";
import { SkillEditor } from "@/screens/SkillEditor";
import { SkillAgentEditor } from "@/screens/SkillAgentEditor";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { Sources } from "@/screens/Sources";
import { GlobalPermissions } from "@/screens/GlobalPermissions";
import { Harnesses } from "@/screens/Harnesses";
import { HarnessConfig } from "@/screens/HarnessConfig";
import { HarnessDocEditor } from "@/screens/HarnessDocEditor";
import { Snippets } from "@/screens/Snippets";
import { SnippetEditor } from "@/screens/SnippetEditor";
import { HooksScreen } from "@/screens/HooksScreen";
import { HookEditor } from "@/screens/HookEditor";
import { RemotesScreen } from "@/screens/RemotesScreen";
import { CloudTarget } from "@/screens/CloudTarget";
import { LocalAgentUsage } from "@/screens/LocalAgentUsage";
import { UsageProjectRoute } from "@/screens/usage/UsageProjectRoute";
import { UsageSessionRoute } from "@/screens/usage/UsageSessionRoute";
import { UsagePinnedSessionsRoute } from "@/screens/usage/UsagePinnedSessionsRoute";
import { BackupScreen } from "@/screens/BackupScreen";
import { RecoveryWizard } from "@/screens/RecoveryWizard";

/**
 * Unit A5a (docs/changes/DESIGN-journey-consolidation/PLAN.md §6, row A5) — the screen
 * contract harness, revised after review: the first cut asserted a header and
 * an escape control, both of which the fully-loaded screen also has, so a row
 * passed even when its loading/error/notFound branch never actually rendered
 * (and the rendered component was never checked against `App.tsx` at all).
 * This file is NEW infrastructure, not a replacement for an existing journey
 * or vitest test — see the original unit's return for why.
 *
 * It scans `App.tsx`'s `<Routes>` block for every `<Route path="…">` the way
 * `ipcParity.test.ts` scans `lib.rs` for `#[tauri::command]` fns, and requires
 * one `ROUTES` row per path (minus the catch-all `*`). Each row does NOT name
 * its own element: `scanRouteElements()` reads the component name straight off
 * the same `<Route path="…" element={<X …/>}>` line, and `COMPONENT_BY_NAME`
 * is the only place a name turns into a renderable component — so a row can
 * never silently render something other than what `App.tsx` actually routes
 * to, and a route whose element `App.tsx` changes fails loudly here instead
 * of quietly testing the old screen.
 *
 * For each row this renders the routed screen — nothing else — through
 * `renderWithProviders`, three times: first-loaded command(s) hung
 * (`loading`), rejected/failed (`error`), and the entity it names missing
 * (`notFound`). Every case asserts:
 *   1. `[data-testid="screen-header"]` (the same selector `headerPresence.
 *      test.tsx` uses),
 *   2. for a route with a URL param (a "detail" route), an escape control,
 *   3. a STATE MARKER (`row.expect[case]`) — text, a role, or a CSS selector
 *      that ONLY that branch renders, so the case can fail when the intended
 *      branch didn't (a bug regressing to the loaded view, or two branches
 *      sharing one piece of UI, would both surface here).
 * A case that cannot meet this today is recorded, never silently dropped, as
 * one of three kinds (see `CaseConfig`):
 *   - `fails`: the header or escape assertion fails today (a product gap).
 *     It runs as `it.fails`, so a product fix turns it red and forces the
 *     entry out.
 *   - `noMarker`: the branch renders identically to another case, so no
 *     marker exists. Header and escape still run; only the marker is skipped.
 *   - `na`: the case does not exist for this screen (a list or dashboard has
 *     no single entity to be missing). Skipped.
 * See the per-row comments and this unit's return for the product gaps.
 *
 * ROOT ROWS — the ones with no `:param`, reachable straight off the nav
 * rail (`/`, `/sources`, `/permissions`, `/harnesses`, `/snippets`, `/hooks`,
 * `/remotes`, `/usage`, `/backup`, `/recovery`) — assert the header + marker
 * only. The rail is their escape control, and it lives in `AppShell`
 * (`App.tsx`), which is not exported and gates its own render behind
 * `usePreflight`/`bootstrap_check` — mounting it here for every root row would
 * mean re-satisfying that gate 30 times over to test a control none of these
 * rows can actually hide. `headerPresence.test.tsx` already renders every
 * screen here bare (no shell) for the same reason. Instead, ONE test below
 * (`the rail is the root screens' escape control`) renders `IconRail`
 * directly and asserts it exposes rail links, independent of any one row.
 */

// ─── ROUTE SCAN (mirrors ipcParity.test.ts's lib.rs scan) ──────────────────

const APP_TSX = join(process.cwd(), "src", "App.tsx");
const APP_TSX_CONTENT = readFileSync(APP_TSX, "utf-8");

/** Every `path="…"` inside a `<Route …>` tag in `App.tsx`. `[^<]*?` keeps the
 *  match from crossing into a route's own (possibly multi-line) JSX `element`
 *  — the only route whose `path` isn't on the same line as `<Route` is the
 *  dev-only `/styleguide` one, and nothing but whitespace sits between
 *  `<Route` and its `path=` there. */
const ROUTE_PATH_RE = /<Route\b[^<]*?\bpath="([^"]+)"/g;

function scanRoutePaths(): string[] {
	const paths: string[] = [];
	let m: RegExpExecArray | null;
	ROUTE_PATH_RE.lastIndex = 0;
	while ((m = ROUTE_PATH_RE.exec(APP_TSX_CONTENT))) paths.push(m[1]);
	return paths;
}

/** `path="…" element={<X` — every ROUTES row but `/styleguide` is one line in
 *  `App.tsx`, so this is stricter (and simpler) than `ROUTE_PATH_RE`: it reads
 *  the JSX component name the route actually mounts. `/styleguide`'s element
 *  is multi-line (`<Suspense><Styleguide/></Suspense>`) and dev-only, so it
 *  isn't covered here — its row is a `skip`, never rendered. */
const ROUTE_ELEMENT_RE = /<Route\s+path="([^"]+)"\s+element=\{<([A-Za-z][\w.]*)/g;

function scanRouteElements(): Map<string, string> {
	const map = new Map<string, string>();
	let m: RegExpExecArray | null;
	ROUTE_ELEMENT_RE.lastIndex = 0;
	while ((m = ROUTE_ELEMENT_RE.exec(APP_TSX_CONTENT))) map.set(m[1], m[2]);
	return map;
}

const ROUTE_ELEMENTS = scanRouteElements();

/** The only place a scanned `App.tsx` element name becomes a component to
 *  render. `LibraryRoute` is `App.tsx`'s own module-local wrapper (`function
 *  LibraryRoute() { const { name } = useParams(); return <SkillLibrary
 *  key={name} />; }`) — not exported, and nothing but a remount key beyond
 *  `SkillLibrary` itself, so it resolves to the same component under test. */
const COMPONENT_BY_NAME: Record<string, () => ReactElement> = {
	SkillLibrary: () => <SkillLibrary />,
	SkillEditor: () => <SkillEditor />,
	SkillAgentEditor: () => <SkillAgentEditor />,
	ProjectWorkspace: () => <ProjectWorkspace />,
	Sources: () => <Sources />,
	GlobalPermissions: () => <GlobalPermissions />,
	Harnesses: () => <Harnesses />,
	HarnessConfig: () => <HarnessConfig />,
	HarnessDocEditor: () => <HarnessDocEditor />,
	Snippets: () => <Snippets />,
	SnippetEditor: () => <SnippetEditor />,
	HooksScreen: () => <HooksScreen />,
	HookEditor: () => <HookEditor />,
	RemotesScreen: () => <RemotesScreen />,
	CloudTarget: () => <CloudTarget />,
	LocalAgentUsage: () => <LocalAgentUsage />,
	UsageProjectRoute: () => <UsageProjectRoute />,
	UsageSessionRoute: () => <UsageSessionRoute />,
	UsagePinnedSessionsRoute: () => <UsagePinnedSessionsRoute />,
	BackupScreen: () => <BackupScreen />,
	RecoveryWizard: () => <RecoveryWizard />,
	LibraryRoute: () => <SkillLibrary />,
};

/** Resolves a row's element the same way `App.tsx` routes it: read the
 *  component name off the scanned `<Route>` line, then look it up in
 *  `COMPONENT_BY_NAME`. Throws (loudly, at render time, naming the row) if
 *  `App.tsx`'s route has no scanned name or no mapped component — a silently
 *  wrong/stale element is exactly the bug this replaces. */
function elementFor(row: RouteRow): ReactElement {
	const name = ROUTE_ELEMENTS.get(row.path);
	const make = name ? COMPONENT_BY_NAME[name] : undefined;
	if (!make) {
		throw new Error(
			`screenContract: ${row.path} scans to element "${name ?? "?"}" in App.tsx, which has no entry in COMPONENT_BY_NAME — add one or fix the row's path`,
		);
	}
	return make();
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const CLAUDE_STATUS: HarnessStatus = {
	id: "claude-code",
	label: "Claude Code",
	installed: true,
	on_globally: true,
	used_by_projects: [],
	global_doc: "/home/test/.claude/CLAUDE.md",
	global_doc_exists: true,
};

/** `hub_cmd`'s argv, the way every `hub_cmd`-driven hook reads it. */
function argvOf(args: unknown): string[] {
	return (args as { args?: string[] } | undefined)?.args ?? [];
}

/** A `hub_cmd` table entry that only intercepts ONE argv shape (matched by
 *  `match`) and delegates everything else — other screens' `source list`,
 *  `harness doc status`, usage-ledger reads, etc. — to `setup.ts`'s own
 *  default `hub_cmd` routing, so a row's mock never has to re-implement the
 *  whole default switch just to fail one sub-verb. */
function hubCmdOverride(
	match: (argv: string[]) => boolean,
	onMatch: (args: unknown) => unknown,
) {
	return (args: unknown) => {
		if (match(argvOf(args))) return onMatch(args);
		return defaultInvokeImpl("hub_cmd" as never, args as never);
	};
}

// ─── State markers ──────────────────────────────────────────────────────

type Marker =
	| { kind: "text"; value: string }
	| { kind: "role"; role: string; name?: string | RegExp }
	| { kind: "selector"; value: string };

/** A substring only the intended branch's text renders. */
function text(value: string): Marker {
	return { kind: "text", value };
}
/** An ARIA role (optionally named) only the intended branch renders — for a
 *  branch whose exact copy depends on run-time classification (e.g. Usage's
 *  error-kind copy) rather than a fixed string. */
function role(roleName: string, name?: string | RegExp): Marker {
	return { kind: "role", role: roleName, name };
}
/** A CSS selector only the intended branch renders — for a branch with no
 *  distinguishing text of its own (a skeleton, a bare loading class). */
function selector(value: string): Marker {
	return { kind: "selector", value };
}

function assertMarker(container: HTMLElement, marker: Marker) {
	switch (marker.kind) {
		case "text":
			expect(container.textContent ?? "").toContain(marker.value);
			return;
		case "selector":
			expect(container.querySelector(marker.value)).toBeTruthy();
			return;
		case "role": {
			const matches = marker.name
				? within(container).queryAllByRole(marker.role, { name: marker.name })
				: within(container).queryAllByRole(marker.role);
			expect(matches.length).toBeGreaterThan(0);
			return;
		}
	}
}

// ─── ROUTES ─────────────────────────────────────────────────────────────

interface CaseConfig {
	/** URL to render at for this case, overriding the row's `url`. */
	url?: string;
	/** Store/registry setup for this case, overriding the row's `setup`. */
	setup?: (client: QueryClient) => void;
	/** The `mockCommands` table for this case. Required unless `na` is set. */
	table?: CommandTable;
	/** The header or escape assertion fails today (product gap; no product
	 *  code is added here to fix it). Runs as `it.fails` without the marker,
	 *  so the product fix turns it red and this entry must go. */
	fails?: string;
	/** The screen has no branch-exclusive marker for this case. Header and
	 *  escape still run; only the marker assertion is skipped. */
	noMarker?: string;
	/** The case does not exist for this screen. Skipped (`it.skip`). */
	na?: string;
}

interface RouteRow {
	path: string;
	/** Present only for `/styleguide`: dev-only, `import.meta.env.DEV`-gated,
	 *  not present in a test/production build. */
	skip?: string;
	url?: string;
	/** No `:param` in `path` ⇒ reachable off the rail; asserts header + marker
	 *  only (see the file doc comment). */
	root?: boolean;
	setup?: (client: QueryClient) => void;
	loading?: CaseConfig;
	error?: CaseConfig;
	notFound?: CaseConfig;
	/** The marker for each case that is neither `fails`, `noMarker` nor
	 *  `na` — see "State markers" above. */
	expect?: { loading?: Marker; error?: Marker; notFound?: Marker };
}

const resetHarnesses = (harnesses: HarnessStatus[] = []) => () =>
	useAppStore.setState({ harnesses, harnessesError: null });

const ROUTES: RouteRow[] = [
	{
		path: "/",
		url: "/",
		root: true,
		loading: { table: { read_registry: hang } },
		error: { table: { read_registry: fail("registry.yaml is unreadable") } },
		notFound: {
			na:
				"the root Library route has no missing-entity state (SkillLibrary.tsx) — /bundle/:name below covers its bundle-not-found branch",
		},
		expect: { loading: text("Loading library"), error: text("Library unavailable") },
	},
	{
		path: "/skill/:name",
		url: "/skill/brainstorm",
		loading: { table: { read_registry: hang } },
		error: { table: { read_registry: fail("registry.yaml is unreadable") } },
		notFound: { url: "/skill/ghost-skill", table: { read_registry: sampleRegistry } },
		// Three separate branches in SkillEditor.tsx (`registryError && !registry`,
		// `!registry`, and the specific-skill-missing guard), so all three have
		// their own text.
		expect: {
			loading: text("Loading skill"),
			error: text("Library unavailable"),
			notFound: text("Skill not found"),
		},
	},
	{
		path: "/skill/:name/agent/:agent",
		url: "/skill/brainstorm/agent/main",
		loading: {
			table: {
				read_registry: sampleRegistry,
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "skill" && argv[1] === "companions" && argv[2] === "agent",
					() => hang,
				),
			},
		},
		error: {
			table: {
				read_registry: sampleRegistry,
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "skill" && argv[1] === "companions" && argv[2] === "agent",
					() => hubFail("could not read the source agent"),
				),
			},
		},
		// SkillAgentEditor.tsx has ONE failure branch (`!query.data`, title
		// "Source agent unavailable") for both a read error and a missing agent
		// — `hub companions agent` failing IS how a missing agent is reported, so
		// there is no marker that renders only for a missing agent and not for a
		// read failure. Keep `error` (the more fundamental case) as the real
		// test; `notFound` has no marker of its own.
		notFound: {
			url: "/skill/brainstorm/agent/ghost-agent",
			table: {
				read_registry: sampleRegistry,
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "skill" && argv[1] === "companions" && argv[2] === "agent",
					() => hubFail("no agent named ghost-agent"),
				),
			},
			noMarker:
				"SkillAgentEditor.tsx's `!query.data` branch (\"Source agent unavailable\") fires for a read error and a missing agent alike — no marker distinguishes a missing agent from `error` (product gap)",
		},
		expect: { loading: text("Loading source agent"), error: text("Source agent unavailable") },
	},
	{
		path: "/project/:name",
		url: "/project/example-app",
		loading: {
			table: { read_registry: hang },
			fails:
				"ProjectWorkspace.tsx's loading branch header has no `back` (no referrer state) — no escape control while read_registry is pending",
		},
		// !registry?.projects?.[name] is true on a read failure too (registry
		// stays undefined), so a failed read hits the SAME branch (title "Project
		// not found") as a genuinely missing project — no marker distinguishes
		// them. Keep `notFound` (the specific, real scenario) as the marked case.
		error: {
			table: { read_registry: fail("registry.yaml is unreadable") },
			noMarker:
				"ProjectWorkspace.tsx has no distinct read-failure branch — a failed read_registry renders the identical \"Project not found\" chrome as `notFound` (product gap)",
		},
		notFound: { url: "/project/ghost-project", table: { read_registry: sampleRegistry } },
		expect: { notFound: text("Project not found") },
	},
	{
		path: "/bundle/:name",
		url: "/bundle/android",
		loading: {
			table: { read_registry: hang },
			fails:
				"SkillLibrary.tsx's loading branch renders the generic 'Library' header with no `back` for a bundle route — no escape control while read_registry is pending",
		},
		error: {
			table: { read_registry: fail("registry.yaml is unreadable") },
			fails:
				"SkillLibrary.tsx's error branch renders the same generic 'Library' header with no `back` when read_registry fails",
		},
		notFound: { url: "/bundle/ghost-bundle", table: { read_registry: sampleRegistry } },
		// BundleNotFoundHeader.tsx's own EmptyState, distinct from both the
		// generic loading/error 'Library' header and the loaded bundle view.
		expect: { notFound: text('Bundle "ghost-bundle" not found') },
	},
	{
		path: "/sources",
		url: "/sources",
		root: true,
		// Sources.tsx reads `const { data: registry } = useRegistry()` and never
		// destructures `isLoading`/`error` at all — a hung or failed read_registry
		// renders the exact same "no sources" EmptyState as a genuinely empty,
		// successfully-read registry. No marker exists for either state.
		loading: {
			table: { read_registry: hang },
			noMarker:
				"Sources.tsx has no isLoading/error branch (only `data` is read) — a pending or failed read_registry renders identically to a successful empty read (product gap)",
		},
		error: {
			table: { read_registry: fail("registry.yaml is unreadable") },
			noMarker:
				"Sources.tsx has no isLoading/error branch (only `data` is read) — a pending or failed read_registry renders identically to a successful empty read (product gap)",
		},
		notFound: { na: "list screen (Sources.tsx); no single entity to be missing" },
	},
	{
		path: "/permissions",
		url: "/permissions",
		root: true,
		loading: { table: { permissions_show: hang, permissions_capabilities: [] } },
		error: {
			table: {
				permissions_show: fail("permissions.toml is unreadable"),
				permissions_capabilities: [],
			},
		},
		notFound: {
			na: "global permissions always exist (GlobalPermissions.tsx); there is no missing-entity state",
		},
		// PermissionsEditor.tsx: `permsQuery.isError` and
		// `permsQuery.isLoading || capsQuery.isLoading || !draft` are separate,
		// mutually exclusive branches ("Failed to load permissions: …" vs
		// "Loading permissions…").
		expect: { loading: text("Loading permissions"), error: text("Failed to load permissions") },
	},
	{
		path: "/harnesses",
		url: "/harnesses",
		root: true,
		setup: resetHarnesses(),
		// Harnesses.tsx has no loading or error branch at all — `useHarnesses()`
		// returns `[]` while pending AND on a rescan failure alike, so the screen
		// renders the identical "0/0 installed" chrome regardless of whether
		// harness_list ever answers.
		loading: {
			table: { harness_list: hang },
			noMarker:
				"Harnesses.tsx has no loading/error branch — a pending or failed harness_list renders identically to zero installed harnesses (product gap)",
		},
		error: {
			table: { harness_list: fail("could not scan harnesses") },
			noMarker:
				"Harnesses.tsx has no loading/error branch — a pending or failed harness_list renders identically to zero installed harnesses (product gap)",
		},
		notFound: { na: "list screen (Harnesses.tsx); no single entity to be missing" },
	},
	{
		path: "/harness/:id",
		url: "/harness/claude-code",
		setup: resetHarnesses(),
		// HarnessConfig.tsx's `supported` fallback (`id === "claude-code" ||
		// id === "codex"`) renders the Sub-Agents manager for a known id
		// regardless of whether `harness_list` has answered, hung, or failed — no
		// marker distinguishes any of the three from a normal render.
		loading: {
			table: { harness_list: hang },
			noMarker:
				"HarnessConfig.tsx's known-id fallback renders the Sub-Agents manager whether harness_list is pending, failed, or resolved — no marker distinguishes them (product gap)",
		},
		error: {
			table: { harness_list: fail("could not scan harnesses") },
			noMarker:
				"HarnessConfig.tsx's known-id fallback renders the Sub-Agents manager whether harness_list is pending, failed, or resolved — no marker distinguishes them (product gap)",
		},
		notFound: { url: "/harness/ghost-harness", table: { harness_list: [] } },
		expect: { notFound: text("No configuration yet") },
	},
	{
		path: "/harness/:id/doc",
		url: "/harness/claude-code/doc",
		setup: resetHarnesses(),
		loading: { table: { global_doc_read: hang } },
		error: { table: { global_doc_read: fail("could not read the instruction file") } },
		// The "unknown harness id" branch needs a NON-empty harness list that
		// simply doesn't contain the id (an empty list reads as "still loading").
		notFound: {
			url: "/harness/ghost-harness/doc",
			setup: resetHarnesses([CLAUDE_STATUS]),
			table: {},
		},
		// Three sequential, mutually exclusive guards in HarnessDocEditor.tsx:
		// unknown id, query.isError, then !doc.
		expect: {
			loading: text("Loading instructions"),
			error: text("Couldn't load the instruction file"),
			notFound: text("No such harness"),
		},
	},
	{
		path: "/snippets",
		url: "/snippets",
		root: true,
		loading: { table: { snippets_list: hang } },
		// A failed `snippets_list` isn't distinguished from an empty one
		// (Snippets.tsx destructures `data: lib = []`) — both render "No
		// snippets yet" with the header intact, same as a genuinely empty
		// library. No marker is exclusive to a read FAILURE.
		error: {
			table: { snippets_list: fail("could not read snippets") },
			noMarker:
				"Snippets.tsx destructures `data: lib = []`, so a failed snippets_list renders the identical \"No snippets yet\" chrome as a genuinely empty library — no marker (product gap)",
		},
		notFound: {
			na: "Snippets.tsx redirects into /snippet/:name or shows 'No snippets yet' — an empty library is its own terminal state, not an entity-not-found",
		},
		expect: { loading: text("Loading snippets") },
	},
	{
		path: "/snippet/:name",
		url: "/snippet/review-checklist",
		loading: {
			table: { snippet_show: hang },
			fails:
				"SnippetDetail's shared loading/not-found header (SnippetEditor.tsx) has no `back` (no referrer state) and the loading EmptyState has no action — no escape control while snippet_show is pending",
		},
		// snippet_show rejecting IS how "no such snippet" is reported — the SAME
		// `if (error)` branch (title "Snippet not found") handles a genuine read
		// failure and a missing snippet alike. Keep `notFound` (the specific,
		// "not found"-worded scenario) as the marked case.
		error: {
			table: { snippet_show: fail("could not read the snippet file") },
			noMarker:
				"SnippetEditor.tsx's `if (error)` branch (\"Snippet not found\") fires for a read failure and a missing snippet alike — no marker distinguishes a read failure from `notFound` (product gap)",
		},
		notFound: { table: { snippet_show: fail("no snippet named review-checklist") } },
		expect: { notFound: text("Snippet not found") },
	},
	{
		path: "/hooks",
		url: "/hooks",
		root: true,
		loading: { table: { hook_list: hang } },
		error: { table: { hook_list: fail("could not read hooks.json") } },
		notFound: { na: "list screen (HooksScreen.tsx); no single entity to be missing" },
		// HooksScreen.tsx: `error ? … : isLoading ? … : …` — mutually exclusive.
		expect: { loading: text("Loading hooks"), error: text("Could not load hooks") },
	},
	{
		path: "/hook/:name",
		url: "/hook/lsp-report",
		loading: { table: { hook_show: hang } },
		// hook_show rejecting IS how "no such hook" is reported — the SAME
		// `if (!isNew && error)` branch (title "Hook not found") handles a read
		// failure and a missing hook alike. Keep `notFound` as the marked case.
		error: {
			table: { hook_show: fail("could not read hooks.json") },
			noMarker:
				"HookEditor.tsx's `if (!isNew && error)` branch (\"Hook not found\") fires for a read failure and a missing hook alike — no marker distinguishes a read failure from `notFound` (product gap)",
		},
		notFound: { url: "/hook/ghost-hook", table: { hook_show: fail("no such hook") } },
		// The loading branch (`isLoading || !hook`) is its own guard, ahead of
		// the error guard, with no title of its own — `.hook-editor-loading` is
		// the only thing that marks it.
		expect: { loading: selector(".hook-editor-loading"), notFound: text("Hook not found") },
	},
	{
		path: "/remotes",
		url: "/remotes",
		root: true,
		loading: { table: { remote_list: hang } },
		error: { table: { remote_list: fail("could not read remotes.toml") } },
		notFound: { na: "list screen (RemotesScreen.tsx); no single entity to be missing" },
		// RemotesScreen.tsx's root return: `error ? … : isLoading ? … : …`.
		expect: { loading: text("Loading remotes"), error: text("Could not load remotes") },
	},
	{
		path: "/remote/:id",
		url: "/remote/example-remote",
		loading: {
			table: { remote_list: hang },
			fails:
				"RemotesScreen.tsx's detail branch returns a bare <p>Loading remote…</p> with no ScreenHeader while isLoading — no header and no escape control (product gap, filed for the parent)",
		},
		// A failed remote_list falls through to RemoteDetail with entry=undefined
		// — but RemoteDetail.tsx only reads `entry` as a `show?.x ?? entry?.x ??
		// default` FALLBACK behind `useRemoteShow(id)`, which the default mock
		// always resolves successfully regardless of `id`. So `entry` being
		// undefined has no visible effect at all: this renders byte-identical
		// chrome to a normal, fully-resolved remote detail. No marker exists.
		error: {
			table: { remote_list: fail("could not read remotes.toml") },
			noMarker:
				"RemoteDetail.tsx only reads `entry` as a fallback behind the always-succeeding `useRemoteShow` mock — a failed remote_list renders identically to a normal detail (product gap, filed for the parent)",
		},
		notFound: {
			url: "/remote/ghost-remote",
			table: { remote_list: [] },
			noMarker:
				"RemotesScreen.tsx/RemoteDetail.tsx have no missing-remote state — an unknown id renders the same detail chrome with empty per-remote fields (product gap, filed for the parent)",
		},
	},
	{
		path: "/cloud/:id",
		url: "/cloud/example-target",
		loading: {
			table: {
				read_registry: sampleRegistry,
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "cloud" && argv[1] === "status",
					() => hang,
				),
			},
		},
		error: {
			table: {
				read_registry: sampleRegistry,
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "cloud" && argv[1] === "status",
					() => hubFail("could not read cloud status"),
				),
			},
		},
		notFound: {
			url: "/cloud/ghost-target",
			table: { read_registry: sampleRegistry },
			noMarker:
				"CloudTarget.tsx has no distinct missing-target state — an unknown id renders the same detail chrome with an empty catalog/status (product gap, filed for the parent)",
		},
		// CloudTarget.tsx: `error ? <EmptyState …/> : (<>… {isLoading ? … : …} …
		// </>)` — the top-level `error` branch fully replaces the fragment the
		// loading hint sits inside, so the two are mutually exclusive.
		expect: {
			loading: text("Reading export state"),
			error: text("Couldn't load this cloud target"),
		},
	},
	{
		path: "/usage",
		url: "/usage",
		root: true,
		loading: { table: { usage_load_latest_ccusage: hang } },
		error: { table: { usage_load_latest_ccusage: fail("could not read the cached scan") } },
		notFound: {
			na:
				"the Usage dashboard (LocalAgentUsage.tsx) has no single entity; empty/failed states render inline banners, not a missing-entity page",
		},
		// UsageLoadingState (role="status") and UsageErrorState (role="alert")
		// are mutually exclusive; the error copy varies with `classifyError`, so
		// `role("alert")` (rather than its exact title) is the stable marker.
		expect: { loading: text("Loading latest cached scan"), error: role("alert") },
	},
	{
		path: "/usage/project/:name",
		url: "/usage/project/example-app",
		loading: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "project",
					() => hang,
				),
			},
		},
		error: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "project",
					() => hubFail("could not read project usage"),
				),
			},
		},
		// UsageProjectArea.tsx: `payload.ok === false && payload.reason ===
		// "not_found"` is a genuine (non-error) "no usage data" contract.
		notFound: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "project",
					() => ({
						success: true,
						output: JSON.stringify({ ok: false, reason: "not_found" }),
					}),
				),
			},
		},
		// Three mutually exclusive branches in UsageProjectArea.tsx: `!payload &&
		// !query.isError` (loading), `!payload && query.isError` (error), and
		// `payload && !payload.ok` (notFound).
		expect: {
			loading: text("Loading…"),
			error: text("Could not load this project's usage"),
			notFound: text("This project's usage is unavailable"),
		},
	},
	{
		path: "/usage/session/:id",
		url: "/usage/session/sess-1",
		loading: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "inspect",
					() => hang,
				),
			},
		},
		error: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "inspect",
					() => hubFail("could not read this session"),
				),
			},
		},
		notFound: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "inspect",
					() => ({
						success: true,
						// NOT "not_captured": UsageSessionRoute.tsx special-cases that one
						// reason to swap to the legacy `UsageSessionTimeline` component
						// entirely, so UsageInspectionPanel's own notFound branch (and its
						// marker below) would never mount.
						output: JSON.stringify({ ok: false, reason: "inspection_corrupt" }),
					}),
				),
			},
		},
		// UsageInspectionPanel.tsx: `query.isPending` (skeleton, no text of its
		// own — `.usage-sheet-skeleton` marks it), `query.isError` (ErrorCard),
		// then `!payload?.ok` (unavailableReason EmptyState) — sequential and
		// mutually exclusive.
		expect: {
			loading: selector(".usage-sheet-skeleton"),
			error: text("Captured inspection could not be read."),
			notFound: text("its local store is corrupt"),
		},
	},
	{
		path: "/usage/pinned",
		url: "/usage/pinned",
		loading: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "pin" && argv[2] === "list",
					() => hang,
				),
			},
		},
		error: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "pin" && argv[2] === "list",
					() => hubFail("could not read pinned sessions"),
				),
			},
		},
		notFound: {
			table: {
				hub_cmd: hubCmdOverride(
					(argv) => argv[0] === "usage" && argv[1] === "pin" && argv[2] === "list",
					() => ({
						success: true,
						output: JSON.stringify({ ok: false, reason: "inspection_corrupt" }),
					}),
				),
			},
		},
		// UsagePinnedSessionsRoute.tsx: `pins.isPending`, `pins.isError`, and
		// `data?.ok === false` are three separate, mutually exclusive lines.
		expect: {
			loading: text("Loading pinned sessions"),
			error: text("Pinned sessions are unavailable"),
			notFound: text("its local store is corrupt"),
		},
	},
	{
		path: "/backup",
		url: "/backup",
		root: true,
		loading: { table: { backup_status: hang } },
		error: { table: { backup_status: fail("could not read backup status") } },
		notFound: { na: "dashboard screen (BackupScreen.tsx); no single entity to be missing" },
		// BackupScreen.tsx: `if (error) return …` is an early, separate return
		// from the main render's `{isLoading && <Dim>…</Dim>}`.
		expect: { loading: text("Loading backup status"), error: text("Cannot read backup status") },
	},
	{
		path: "/recovery",
		url: "/recovery",
		root: true,
		loading: { table: { recovery_command: hang } },
		error: { table: { recovery_command: fail("could not read recovery status") } },
		// A "no restore in progress" payload is a genuine, distinct RecoveryWizard.tsx
		// branch (`hasRecord === false`) — the closest this screen has to "missing".
		notFound: {
			table: {
				recovery_command: () => ({
					ok: true,
					operation_id: null,
					stage: "sources",
					needs_recovery: false,
					dismissed: false,
					completed: false,
					bootstrap: { completed: true, completed_at: null, restored_from: null },
					backup: { pending_reconcile: false },
					projects: [],
					projects_summary: { ready: 0, pending: 0, skipped: 0, failed: 0, interrupted: 0, total: 0 },
					sources: [],
					local_sources: [],
				}),
			},
		},
		// RecoveryWizard.tsx: `status.isLoading`, `status.isError || !status.data`,
		// then `!hasRecord` — sequential, mutually exclusive guards.
		expect: {
			loading: text("Reading recovery status"),
			error: text("Cannot read recovery status"),
			notFound: text("Nothing to recover here"),
		},
	},
	{
		path: "/styleguide",
		skip: "dev-only screen (import.meta.env.DEV-gated in App.tsx); not present in a test/production build",
	},
];

// ─── Assertions ──────────────────────────────────────────────────────────

function hasHeader(container: HTMLElement): boolean {
	return !!container.querySelector('[data-testid="screen-header"]');
}

/** A back control, wherever the screen put it: the header's dedicated slot
 *  (`headerPresence.test.tsx`'s own selector), or any back-labelled button/
 *  link in the body (e.g. `SnippetEditor`'s "Back to snippets" `BackButton`,
 *  which sits in the EmptyState, not the header). */
function hasEscape(container: HTMLElement): boolean {
	if (container.querySelector('[data-testid="screen-header-back"]')) return true;
	return Array.from(container.querySelectorAll("button, a")).some((el) => {
		const label = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
		return /\bback\b/i.test(label);
	});
}

// ─── Completeness: one row per scanned App.tsx route, each resolvable ────

describe("screen contract: ROUTES completeness", () => {
	it("has exactly one row for every App.tsx <Route> path (except the wildcard)", () => {
		const scanned = scanRoutePaths().filter((p) => p !== "*");
		const rowPaths = ROUTES.map((r) => r.path);

		const missing = scanned.filter((p) => !rowPaths.includes(p));
		expect(missing, `ROUTES is missing a row for: ${missing.join(", ")}`).toEqual([]);

		const extra = rowPaths.filter((p) => !scanned.includes(p));
		expect(extra, `ROUTES has a row with no matching App.tsx route: ${extra.join(", ")}`).toEqual([]);

		const duplicates = rowPaths.filter((p, i) => rowPaths.indexOf(p) !== i);
		expect(duplicates, `ROUTES has duplicate rows for: ${duplicates.join(", ")}`).toEqual([]);

		const nonStyleguideSkips = ROUTES.filter((r) => r.skip && r.path !== "/styleguide");
		expect(
			nonStyleguideSkips.map((r) => r.path),
			"only /styleguide may use a row-level `skip`",
		).toEqual([]);
	});

	it("every non-skip row's App.tsx element resolves to a mapped component", () => {
		const unresolvable = ROUTES.filter((r) => !r.skip)
			.filter((r) => {
				const name = ROUTE_ELEMENTS.get(r.path);
				return !name || !(name in COMPONENT_BY_NAME);
			})
			.map((r) => r.path);
		expect(
			unresolvable,
			`ROUTES row has no component mapped for its scanned App.tsx element: ${unresolvable.join(", ")}`,
		).toEqual([]);
	});

	it("every run case has a mockCommands table, and a state marker unless recorded without one", () => {
		const missingTable: string[] = [];
		const missingMarker: string[] = [];
		const ambiguous: string[] = [];
		for (const row of ROUTES) {
			if (row.skip) continue;
			for (const name of ["loading", "error", "notFound"] as const) {
				const cfg = row[name];
				if (!cfg) {
					missingTable.push(`${row.path} ${name} (no case configured)`);
					continue;
				}
				const kinds = [cfg.fails, cfg.noMarker, cfg.na].filter(Boolean).length;
				if (kinds > 1) ambiguous.push(`${row.path} ${name}`);
				if (cfg.na) continue;
				if (!cfg.table) missingTable.push(`${row.path} ${name}`);
				if (!cfg.fails && !cfg.noMarker && !row.expect?.[name]) missingMarker.push(`${row.path} ${name}`);
			}
		}
		expect(ambiguous, `case sets more than one of fails/noMarker/na: ${ambiguous.join(", ")}`).toEqual([]);
		expect(missingTable, `case configured without a mockCommands table: ${missingTable.join(", ")}`).toEqual([]);
		expect(
			missingMarker,
			`case configured without a state marker in row.expect: ${missingMarker.join(", ")}`,
		).toEqual([]);
	});
});

// ─── Per-row: loading / error / notFound ────────────────────────────────

for (const row of ROUTES) {
	if (row.skip) {
		describe(`screen contract: ${row.path}`, () => {
			it.skip(`SKIPPED — ${row.skip}`, () => {});
		});
		continue;
	}

	describe(`screen contract: ${row.path}`, () => {
		const cases: Array<["loading" | "error" | "notFound", CaseConfig | undefined]> = [
			["loading", row.loading],
			["error", row.error],
			["notFound", row.notFound],
		];

		for (const [name, cfg] of cases) {
			if (!cfg || cfg.na) {
				it.skip(`${name} — SKIPPED — ${cfg?.na ?? "no case configured"}`, () => {});
				continue;
			}

			const escapeText = row.root ? "" : " and an escape control";
			const title = cfg.fails
				? `${name} keeps the header${escapeText} (known failure: ${cfg.fails})`
				: cfg.noMarker
					? `${name} keeps the header${escapeText} (no state marker: ${cfg.noMarker})`
					: `${name} keeps the header${escapeText}, with its own state marker`;

			(cfg.fails ? it.fails : it)(title, async () => {
				const client = makeQueryClient();
				(cfg.setup ?? row.setup)?.(client);
				mockCommands(cfg.table ?? {});

				const { container } = renderWithProviders(
					<Routes>
						<Route path={row.path} element={elementFor(row)} />
					</Routes>,
					{ initialRoute: cfg.url ?? row.url ?? row.path, client },
				);

				const marker = cfg.fails || cfg.noMarker ? undefined : row.expect?.[name];
				await waitFor(() => {
					expect(hasHeader(container)).toBe(true);
					if (!row.root) expect(hasEscape(container)).toBe(true);
					if (marker) assertMarker(container, marker);
				});
			});
		}
	});
}

// ─── The rail: the root screens' shared escape control ──────────────────

describe("screen contract: the rail is the root screens' escape control", () => {
	it("IconRail renders a link back to the Library for every root row's 'elsewhere'", async () => {
		const { IconRail } = await import("@/components/IconRail");
		mockCommands({ read_registry: sampleRegistry });
		const client = makeQueryClient();
		const { container } = renderWithProviders(<IconRail />, { client });
		await waitFor(() => {
			expect(
				Array.from(container.querySelectorAll("a, button")).some((el) =>
					/library/i.test(`${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`),
				),
			).toBe(true);
		});
	});
});
