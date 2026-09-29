// ─── MCP payload mirrors (INTERFACES §3/§4/§6) ───────────────────────────────
// The TypeScript twin of `mcp_spec.py` / `mcp_probe.py` / `hub_cli/mcp.py`'s
// `--json` shapes. E1 adds nothing the Python side does not already emit — it
// only compiles a typed reader + the two secret-detection helpers, whose
// PATTERNS are read from the same corpus fixture `mcp_spec.py` reads (m12), so
// the two runtimes cannot silently drift.
//
// E2 imports every export here rather than re-declaring (plans/E1.md §3).

import type { McpSpec, McpTransport } from "@/types";
import type { BadgeChannel } from "@/components/StatusBadge";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import corpus from "../../../tests/fixtures/mcp_secret_corpus.json";

export type { McpSpec, McpTransport };

// ─── `hub mcp check` / the probe row (INTERFACES §3) ─────────────────────────

export type McpProbeState =
	| "ok"
	| "unresolved_ref"
	| "unreachable"
	| "protocol_error"
	| "timeout"
	| "unsupported";

export interface McpProbe {
	name: string;
	transport: McpTransport;
	state: McpProbeState;
	tool_count: number | null;
	tools: string[];
	latency_ms: number | null;
	protocol_version: string | null;
	unresolved_refs: string[];
	env_from_shell: boolean;
	error: string | null;
	checked_at: string;
	/** G1 adds this (INTERFACES §3) — OPTIONAL, not `| null`: a row written by
	 *  an older `hub` on PATH simply lacks the key (`undefined`), which every
	 *  read site here must treat exactly like `null` ("nothing was fetched").
	 *  `null` itself means the probe ran but no catalogue call happened
	 *  (state != "ok", or `--no-catalog`). */
	catalog?: McpCatalogSummary | null;
}

// ─── MCP capability catalogue (`hub mcp catalog`, INTERFACES §3, plans/G.md
// §6-7, rev 3 §11) ─────────────────────────────────────────────────────────

export type McpCatalogKind = "tools" | "resources" | "resource_templates" | "prompts";

export interface McpToolParameter {
	name: string;
	type: string | null;
	required: boolean;
	description: string | null;
	enum: (string | number | boolean | null)[] | null;
	enum_truncated: boolean;
	default: string | number | boolean | null;
	items_type: string | null;
}

/** Rev 3 §11.5/§11.6 — each hint is `bool | null`; `null` means the server
 *  did not declare it, distinct from `false`. These are untrusted, unverified
 *  hints per the MCP spec itself — rendered as neutral `Chip`s, never a
 *  `RiskBadge` (that primitive is a verified-risk pill on the warn/error
 *  channels, and amber is the closed warn-severity set). */
export interface McpToolAnnotations {
	read_only: boolean | null;
	destructive: boolean | null;
	idempotent: boolean | null;
	open_world: boolean | null;
}

export interface McpCatalogTool {
	name: string;
	/** Rev 3 §11 — optional even at 2025-06-18. Falls back to `name`; shown
	 *  alongside it only when the two differ (§11.4) — see `titledLabel`. */
	title?: string | null;
	description: string | null;
	parameters: McpToolParameter[];
	schema_unreadable: boolean;
	parameters_truncated: boolean;
	annotations?: McpToolAnnotations | null;
	/** What the tool RETURNS, flattened in the same shape as `parameters`
	 *  (§11.5/§11.6) — rendered as a collapsed RETURNS table beneath
	 *  PARAMETERS so it never competes with the inputs. */
	output_parameters?: McpToolParameter[];
	/** `false` is the common case (no `outputSchema` declared) and must read
	 *  as ordinary, never as an error or a gap. */
	output_schema_present?: boolean;
	output_schema_unreadable?: boolean;
}

export interface McpCatalogResource {
	uri: string;
	title?: string | null;
	name: string | null;
	description: string | null;
	mime_type: string | null;
}

export interface McpCatalogResourceTemplate {
	uri_template: string;
	title?: string | null;
	name: string | null;
	description: string | null;
	mime_type: string | null;
}

export interface McpCatalogPromptArgument {
	name: string;
	description: string | null;
	required: boolean;
}

export interface McpCatalogPrompt {
	name: string;
	title?: string | null;
	description: string | null;
	arguments: McpCatalogPromptArgument[];
}

export interface McpCatalogOffered {
	tools: boolean;
	resources: boolean;
	resource_templates: boolean;
	prompts: boolean;
}

export interface McpCatalogFetchError {
	method: string;
	error: string;
}

export interface McpCatalog {
	schema_version: number;
	name: string;
	fetched_at: string;
	transport: string;
	protocol_version: string | null;
	server_name: string | null;
	server_version: string | null;
	/** Rev 3 §11.5. */
	server_title?: string | null;
	/** Rev 3 §11.2 — diagnostic only, like `capabilities`: never rendered in
	 *  the block or the sheet's body. The sheet's instructions-disclosure
	 *  foot is the one acceptable place, and only as quiet dim text. */
	protocol_fallback?: boolean;
	instructions: string | null;
	capabilities: string[];
	offered: McpCatalogOffered;
	tools: McpCatalogTool[];
	resources: McpCatalogResource[];
	resource_templates: McpCatalogResourceTemplate[];
	prompts: McpCatalogPrompt[];
	truncated: Record<McpCatalogKind, boolean>;
	bytes_truncated: boolean;
	fetch_errors: McpCatalogFetchError[];
}

/** Rides the probe row as `catalog` (INTERFACES §3) — the glance block needs
 *  no second CLI call. The full record NEVER rides the row. */
export interface McpCatalogSummary {
	tools: number;
	resources: number;
	resource_templates: number;
	prompts: number;
	offered: McpCatalogOffered;
	/** Kinds whose fetch errored — lets the app say "unknown" instead of the
	 *  lie "0 resources" (grill F12). */
	unknown: McpCatalogKind[];
	server_name: string | null;
	server_version: string | null;
	instructions: boolean;
	errors: number;
}

/** `hub mcp catalog --json` (INTERFACES §3) — a discriminated union on `ok`,
 *  never a bare record, so a caller can tell "nothing fetched yet" apart from
 *  a real result without a second field. */
export type McpCatalogPayload =
	| { ok: true; catalog: McpCatalog }
	| { ok: false; error: string; code: "no_catalog" };

// ─── delivery rows (sync report, INTERFACES §4) ──────────────────────────────

export type McpDeliveryState = "written" | "unchanged" | "skipped" | "blocked";

/** The eleven named reasons a delivery row may carry, plus `null` (nothing to
 *  explain). `source_disabled` was DROPPED from the wave-C contract (the
 *  coordinator's mid-review correction) — it never shipped in INTERFACES §4
 *  and must not appear here. */
export type McpDeliveryReason =
	| "affinity"
	| "no_global_target"
	| "not_hub_owned"
	| "adapter_missing"
	| "parse_aborted"
	| "claude_project_not_approved"
	| "codex_untrusted_project"
	| "codex_no_sse"
	| "codex_header_not_representable"
	| "codex_env_not_representable"
	| "opencode_default_dropped";

export interface McpDeliveryRow {
	harness: string;
	adapter: string;
	scope: string;
	server: string;
	target_file: string;
	state: McpDeliveryState;
	reason: McpDeliveryReason | null;
	detail: string | null;
}

// ─── `hub mcp show --json` (INTERFACES §3) ───────────────────────────────────

export interface McpResolvedRow {
	harness: string;
	adapter: string;
	scope: string;
	target_file: string;
	native: Record<string, unknown> | null;
	supported: boolean;
	reason: string | null;
}

export interface McpEquippedSummary {
	projects: string[];
	bundles: string[];
	remotes: string[];
	cloud: string[];
}

export interface McpShowPayload {
	ok: boolean;
	name: string;
	scope: string;
	description: string;
	harnesses: string[] | null;
	spec: McpSpec;
	secret_refs: string[];
	literal_secret_keys: string[];
	equipped: McpEquippedSummary;
	resolved: McpResolvedRow[];
	last_probe: McpProbe | null;
}

// ─── `hub mcp reconcile` candidate row (INTERFACES §3 — E2's territory; the
// types are declared here per plans/E1.md §3 so E2 imports rather than
// re-declares) ─────────────────────────────────────────────────────────────

export type McpCandidateStatus =
	| "new"
	| "conflict"
	| "already_managed"
	| "unsupported"
	| "stale";

/** Codex user-level config and opencode's global config both discover as
 *  `"global"` (grill finding 5) — `"user"` is Claude Code's own name for its
 *  equivalent (top-level `~/.claude.json` `mcpServers`), never merged into
 *  `"global"` at this layer so a card can still say which harness it is. */
export type McpScope = "user" | "local" | "project" | "global";

export type McpUnsupportedReason =
	| "ws_transport"
	| "oauth_block"
	| "headers_helper"
	| "unknown_shape"
	| "local_scope_unregistered_project"
	| "no_global_target"
	| "invalid_name"
	| "name_taken"
	| "unknown_transport"
	| "transport_conflict"
	| "no_endpoint"
	| "malformed_url"
	| "unsupported_url_scheme"
	| "malformed_field"
	| "duplicate_header"
	| "disabled_upstream"
	| "unreadable_file";

export interface McpCandidateSource {
	harness: string;
	file: string;
	scope: McpScope;
	/** The native key VERBATIM (pre-slugify) — the candidate's own `name` is
	 *  the resolved slug, which can differ per-source before a rename decides
	 *  one (E3 rev 2 §2.2/§4). */
	name: string;
	native: Record<string, unknown>;
}

export interface McpCandidateOption {
	/** `"registry"` (the F5 unclaimed-native-entry pseudo-option) names no
	 *  real harness — `scope`/`file` are both `null` there. */
	harness: string;
	/** Distinguishes Claude's user-scope `mcpServers` from its local scope
	 *  (`projects.<abs>.mcpServers`) — an option is identified by
	 *  `(harness, scope)`; `file` breaks a tie when both share one (D review
	 *  W4: Claude's local vs project copies can share a harness). */
	scope: McpScope | null;
	file: string | null;
	spec: McpSpec;
}

export interface McpCandidate {
	/** The resolved registry slug this candidate would use — already
	 *  slugified (E3 rev 2 §2.2). Equal to `import_name` on every ACTIONABLE
	 *  row; only diverges for an `unsupported/invalid_name` row, where `name`
	 *  is the raw, unslugifiable native key and `import_name` is `null`. */
	name: string;
	status: McpCandidateStatus;
	spec: McpSpec | null;
	sources: McpCandidateSource[];
	options: McpCandidateOption[];
	reason: string | null;
	warnings: string[];
	/** `null` only for `unsupported/invalid_name` — otherwise `slugify_server_name(<raw native key>)`, i.e. `name` itself. */
	import_name: string | null;
}

// ─── `hub mcp set --json` payload (INTERFACES §3 — the undo/save contract) ───

export interface McpSetResult {
	ok: boolean;
	name: string;
	spec: McpSpec;
	changed_keys: string[];
	warnings: string[];
	prior_spec: McpSpec;
}

// ─── `hub mcp reconcile --apply` / `hub mcp add` failures (E3 rev 2 §2.5) ────

/** The closed `code` vocabulary (INTERFACES §3, `mcp_vocabulary.json`
 *  `failure_codes`) — pinned by an exhaustiveness test against that fixture. */
export type McpFailureCode =
	| "literal_secret"
	| "invalid_name"
	| "name_taken"
	| "name_collision_in_batch"
	| "ambiguous_option"
	| "unknown_candidate"
	| "invalid_spec"
	| "invalid_json"
	// `hub mcp catalog` fail-closed exit. It lives in this SHARED vocabulary
	// rather than a parallel `catalog_failure_codes` key so the bidirectional
	// exhaustiveness tests on both runtimes keep covering it.
	| "no_catalog"
	| "other";

/** The `{"ok": false, ...}` shape every fail-closed `hub mcp add --json` /
 *  `hub mcp reconcile … --json` exit prints (E3 rev 2 §2.5). `reason` carries
 *  the normaliser's word when `code === "invalid_spec"`; `name` is present
 *  whenever the refusal already resolved one. */
export interface McpFailure {
	ok: false;
	error: string;
	code: McpFailureCode;
	reason?: string;
	name?: string;
}

// ─── `hub mcp reconcile --apply` success payload (INTERFACES §3) ────────────

export interface McpRenamedEntry {
	from: string;
	to: string;
}

/** A project-scope claim (rewritten by the next sync) or a removed native
 *  copy (Claude local, or any file no adapter writes at this scope) —
 *  E3 rev 2 §2.3. Always empty at global scope. */
export interface McpClaimedEntry {
	harness: string;
	scope: string;
	file: string;
}

export interface McpApplySummary {
	ok: true;
	imported: string[];
	kept: string[];
	unkept: string[];
	skipped: string[];
	conflicts_resolved: number;
	synced: boolean;
	suggested_refs: { name: string; key: string; var: string }[];
	renamed: McpRenamedEntry[];
	claimed: McpClaimedEntry[];
	removed_native: McpClaimedEntry[];
	errors: string[];
}

// ─── name normalisation — the TS twin of `mcp_spec.slugify_server_name`
// (E3 rev 2 §2.1/§2.2) ────────────────────────────────────────────────────

/** A raw name carrying `/` or `\` is refused outright — never derive a
 *  filesystem path from separator debris (catalogue N10/N11). The NUL-byte
 *  half of that same check is a plain `.includes()` below, not a regex
 *  character class (`no-control-regex` refuses a literal `\x00` there). */
const PATH_LIKE_RE = /[/\\]/;
const SLUG_RE = /^[a-z0-9-]+$/;

/** NFKD-normalize, drop combining marks, lowercase, collapse every run of
 *  characters outside `[a-z0-9-]` to a single `-`, then strip leading and
 *  trailing `-`. `null` (the `invalid_name` signal) when `raw` is not a
 *  non-empty string, carries `/`, `\`, or a NUL byte, is a bare `.`/`..`
 *  segment, or the result is empty or still fails the slug pattern. No
 *  length refusal. Mirrors `mcp_spec.slugify_server_name` — pinned against
 *  every corpus case's `name` → `expect.import_name` (case 17).
 *
 *  N2: Python drops a decomposed character when its Unicode CANONICAL
 *  COMBINING CLASS is non-zero (`unicodedata.combining(ch) != 0`) — not
 *  every combining-mark character. JS has no combining-class accessor, so
 *  this drops `\p{Mn}` (non-spacing marks — the class that carries a
 *  non-zero combining class in virtually every practical case, ordinary
 *  Latin diacritics included) and deliberately LEAVES `\p{Mc}`/`\p{Me}`
 *  (spacing-combining / enclosing marks, whose combining class is almost
 *  always zero) for the collapse step below to turn into `-`, same as
 *  Python. Not a byte-exact port — an approximation pinned to the one case
 *  the two runtimes are known to diverge on (`"aाb"` → `"a-b"`, a
 *  Devanagari spacing vowel sign, `mcpContract.test.ts`). */
export function slugifyServerName(raw: unknown): string | null {
	if (typeof raw !== "string" || raw === "") return null;
	if (PATH_LIKE_RE.test(raw) || raw.includes("\0")) return null;
	const stripped = raw.trim();
	if (stripped === "" || stripped === "." || stripped === "..") return null;
	const decomposed = stripped.normalize("NFKD");
	const withoutMarks = decomposed.replace(/\p{Mn}/gu, "");
	const lowered = withoutMarks.toLowerCase();
	const collapsed = lowered.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!collapsed || !SLUG_RE.test(collapsed)) return null;
	return collapsed;
}

// ─── bounded, DOM-safe detail (W5, the TS twin of `mcp_spec._bounded_detail`) ─

const BOUNDED_DETAIL_LIMIT = 40;

/** Non-printable per Python's `str.isprintable()`: control, format,
 *  surrogate, private-use and unassigned code points, plus every SEPARATOR
 *  except the ASCII space (which Python explicitly keeps printable). */
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** A stdin- or native-key-controlled string is NEVER interpolated into the
 *  DOM raw (W5) — it may carry a NUL byte, be arbitrarily long, or hold
 *  non-printable bytes. Mirrors `mcp_spec._bounded_detail`: every
 *  non-printable code point (the ASCII space excepted) becomes `�`, then
 *  the result is capped at 40 characters with a trailing `…`. */
export function boundedDetail(value: unknown, limit = BOUNDED_DETAIL_LIMIT): string {
	const text = typeof value === "string" ? value : String(value);
	const cleaned = Array.from(text)
		.map((ch) => (ch === " " || !NON_PRINTABLE_RE.test(ch) ? ch : "�"))
		.join("");
	if (cleaned.length > limit) {
		return `${cleaned.slice(0, Math.max(limit - 1, 0))}…`;
	}
	return cleaned;
}

// ─── place naming — "who configures this, and where" (E3 rev 2 §2.4/§2.6) ───

/** `Claude Code (user)` / `Codex (global)` / `Skill Tree's own record` (the
 *  F5 registry pseudo-option, `harness === "registry"`, has no scope). Used
 *  by the band's conflict-row line and the compare sheet's consequence
 *  lines — the card HEADER label uses its own `·`-joined form instead
 *  (`McpCompareSheet.tsx`). */
export function placeLabel(harness: string, scope: string | null | undefined): string {
	if (harness === "registry") return "Skill Tree's own record";
	return scope ? `${harnessLabel(harness)} (${scope})` : harnessLabel(harness);
}

/** `A` / `A and B` / `A, B, and C` — the one join grammar the band's
 *  conflict-row line and the harness `found in …` line share (E3 rev 2
 *  §2.6: "deduped, `, ` + final ` and `"). */
export function joinLabels(labels: string[]): string {
	const uniq = [...new Set(labels)];
	if (uniq.length === 0) return "";
	if (uniq.length === 1) return uniq[0];
	if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
	return `${uniq.slice(0, -1).join(", ")}, and ${uniq[uniq.length - 1]}`;
}

// ─── rename detection (E3 rev 2 §2.2/§2.6) ───────────────────────────────────

/** True when adopting this candidate registers it under a name that differs
 *  from at least one of its native sources — the `renamed_from:<native>`
 *  warning is the signal `classify` already computed (`base_warnings`), so
 *  the UI never re-derives it from `sources`/`name` itself. */
export function candidateIsRenamed(cand: McpCandidate): boolean {
	return cand.warnings.some((w) => w.startsWith("renamed_from:"));
}

/** The native source a compare-sheet OPTION resolves to — matched by
 *  `(harness, scope, file)` first, falling back to `(harness, scope)` (W2/W4:
 *  two options can share a harness+scope, but `sources` always carries the
 *  file too). `undefined` for the F5 registry pseudo-option, which names no
 *  real source. */
export function sourceForOption(
	cand: McpCandidate,
	option: McpCandidateOption,
): McpCandidateSource | undefined {
	if (option.harness === "registry") return undefined;
	return (
		cand.sources.find(
			(s) => s.harness === option.harness && s.scope === option.scope && s.file === option.file,
		) ?? cand.sources.find((s) => s.harness === option.harness && s.scope === option.scope)
	);
}

/** `cand.name` (the slug this option would register under) when adopting
 *  THIS option would rename its own native copy, else `null`. The F5
 *  registry pseudo-option is always inert here — nothing is registered
 *  there, so there is nothing to rename (grill finding 18). */
export function optionRenamedTo(cand: McpCandidate, option: McpCandidateOption): string | null {
	const src = sourceForOption(cand, option);
	if (!src || src.name === cand.name) return null;
	return cand.name;
}

// ─── adoption consequences — what happens to every OTHER copy (E3 rev 2 §2.3/§2.4) ─

export interface McpConsequenceLine {
	place: string;
	verb: "Updates" | "Removes";
}

/** Deep structural equality over plain JSON-shaped values (object key order
 *  ignored) — the frontend's read of the same "same bytes, skip it" test
 *  `_apply_project_scope_ownership` runs against `chosen_block`/`entry_block`. */
function deepJsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => deepJsonEqual(v, b[i]));
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		const ak = Object.keys(a as Record<string, unknown>);
		const bk = Object.keys(b as Record<string, unknown>);
		if (ak.length !== bk.length) return false;
		return ak.every(
			(k) =>
				Object.prototype.hasOwnProperty.call(b, k) &&
				deepJsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
		);
	}
	return false;
}

/** The reconcile scope a candidate is being adopted INTO — mirrors
 *  `hub_cli.mcp._apply_project_scope_ownership`'s own `scope_kind` (E3 rev 2
 *  §2.3). `useMcpDecisions.ts` hardcodes `--global` today, so `"project"` is
 *  latent — plumbed through so the copy is correct the moment a caller wires
 *  a project-scope reconcile in. */
export type McpReconcileScopeKind = "global" | "project";

/** Per 2.2/2.3, mirroring the Python branches exactly (W3, W9):
 *
 *  - **Rename** (`candidateIsRenamed`, i.e. the resolved import name differs
 *    from at least one native source's own key): `_reconcile_apply_mcp`
 *    checks `r["is_renamed"]` BEFORE it ever reaches the scope branch below
 *    (`hub_cli/mcp.py:2352-2369`) and removes EVERY native source, by its own
 *    key, at EITHER scope kind — the 2.3 scope rule never runs for it. A
 *    card must never promise `Updates` where the apply actually deletes the
 *    entry (W9), so this returns `Removes` for every source, chosen one
 *    included, before either scope branch below.
 *  - **Global scope**: nothing is claimed or removed — the global writers
 *    overwrite by name and the sync tail replaces every sidecar, so every
 *    OTHER native copy (never the one being adopted) is simply `Updates`.
 *  - **Project scope**: a source whose scope is `local` is `Removes`
 *    UNCONDITIONALLY — winner or loser, since no per-project adapter writes
 *    that file (`_apply_project_scope_ownership`: "winner or loser" — gated
 *    on `scope == "local"` alone, `hub_cli/mcp.py:1788`, not also on the
 *    harness). A source with no matching option (two identical native
 *    copies collapsed to one option) gets no line at all, same as Python's
 *    `entry is None: continue` (`hub_cli/mcp.py:1805-1806`) — never an
 *    unconditional `Updates`. Every OTHER source whose spec already matches
 *    what is being adopted also needs no consequence line (Python: `if
 *    entry_block == chosen_block: continue`); every source whose spec
 *    differs — the one being adopted included, on the rare chance its own
 *    recorded copy already drifted from itself — is `Updates`. */
export function adoptionConsequences(
	cand: McpCandidate,
	option: McpCandidateOption,
	scopeKind: McpReconcileScopeKind,
): McpConsequenceLine[] {
	if (candidateIsRenamed(cand)) {
		return cand.sources.map((s) => ({ place: placeLabel(s.harness, s.scope), verb: "Removes" as const }));
	}

	const chosen = sourceForOption(cand, option);
	const isChosen = (s: McpCandidateSource) =>
		!!chosen && s.harness === chosen.harness && s.scope === chosen.scope && s.file === chosen.file;
	const out: McpConsequenceLine[] = [];

	if (scopeKind === "global") {
		for (const s of cand.sources) {
			if (isChosen(s)) continue;
			out.push({ place: placeLabel(s.harness, s.scope), verb: "Updates" });
		}
		return out;
	}

	for (const s of cand.sources) {
		if (s.scope === "local") {
			out.push({ place: placeLabel(s.harness, s.scope), verb: "Removes" });
			continue;
		}
		const matchingOption = cand.options.find(
			(o) => o.harness === s.harness && o.scope === s.scope && o.file === s.file,
		);
		if (!matchingOption) continue;
		if (deepJsonEqual(matchingOption.spec, option.spec)) continue;
		out.push({ place: placeLabel(s.harness, s.scope), verb: "Updates" });
	}
	return out;
}

// ─── query-value masking (N3) ─────────────────────────────────────────────────

/** Masks a query-string parameter's VALUE in `url` with a literal `••••••`,
 *  WITHOUT the percent-encoding `URLSearchParams.set` applies to those bullet
 *  characters (N3 — `?token=%E2%80%A2…` is not a mask, it's mojibake). Builds
 *  the replacement query string by hand instead of round-tripping through
 *  `URLSearchParams`. Returns `url` unchanged if it is not a valid URL or
 *  carries no such param. */
export function maskQueryParam(url: string, param: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	if (!u.searchParams.has(param)) return url;
	const masked = u.search
		.slice(1)
		.split("&")
		.map((pair) => {
			const eqIdx = pair.indexOf("=");
			const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
			let key = rawKey;
			try {
				key = decodeURIComponent(rawKey.replace(/\+/g, "%20"));
			} catch {
				/* malformed percent-encoding in the key — compare it raw */
			}
			return key === param ? `${rawKey}=••••••` : pair;
		})
		.join("&");
	return `${u.origin}${u.pathname}${masked ? `?${masked}` : ""}${u.hash}`;
}

// ─── warning-word copy (E3 rev 2 §2.6) ───────────────────────────────────────

/** One dim line per candidate/payload warning word — the band row, the
 *  compare sheet, and the New sheet's result all share this. `renamed_from`
 *  needs the RESOLVED name (the candidate's own `name`, not the raw native
 *  key in its own detail) to read as the registry key it becomes. */
export function warningLine(warning: string, resolvedName?: string): string {
	const idx = warning.indexOf(":");
	const word = idx === -1 ? warning : warning.slice(0, idx);
	const detail = idx === -1 ? null : warning.slice(idx + 1);
	switch (word) {
		case "renamed_from":
			return resolvedName ? `registered as ${resolvedName}` : "registered under a different name";
		case "command_has_arguments":
			return "The command contains spaces; hub does not split it.";
		case "command_list_split":
			return "Command list split into command + args.";
		case "dropped_field":
			return `${detail ?? "A field"} was dropped.`;
		default:
			return `${word.replace(/_/g, " ")}${detail ? `: ${detail}` : ""}`;
	}
}

// ─── endpoint / secret helpers ────────────────────────────────────────────────

/** `url` for http/sse, `"npx -y @scope/pkg"` (command + args) for stdio, `""`
 *  for a bare spec with no command and no url. */
export function endpointLabel(spec: McpSpec): string {
	if (spec.transport === "http" || spec.transport === "sse") {
		return spec.url ?? "";
	}
	const command = (spec.command ?? "").trim();
	if (!command) return "";
	return [command, ...(spec.args ?? [])].join(" ").trim();
}

/** `${VAR}` / `${VAR:-default}` — the one grammar every reader/writer shares
 *  (mirrors `mcp_spec._REF_RE`). */
const REF_RE_SOURCE = "\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\\}";

/** The `${VAR}` names in `value`, in order, deduped. `[]` for anything that is
 *  not a string or carries no reference. */
export function refNames(value: string | undefined | null): string[] {
	if (typeof value !== "string") return [];
	const re = new RegExp(REF_RE_SOURCE, "g");
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(value))) {
		if (!out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/** Every `${VAR}` name across `env`, `headers` and `url` — deduped, sorted
 *  (mirrors `hub_cli.mcp._mcp_ref_names_in_spec`). */
export function secretRefsOf(spec: McpSpec): string[] {
	const names = new Set<string>();
	for (const v of Object.values(spec.env ?? {})) for (const n of refNames(v)) names.add(n);
	for (const v of Object.values(spec.headers ?? {})) for (const n of refNames(v)) names.add(n);
	for (const n of refNames(spec.url)) names.add(n);
	return [...names].sort();
}

// ─── literal-secret heuristic — compiled from the shared corpus (m9, m12) ────

interface McpSecretPatterns {
	key_re: string;
	value_re: string;
	prefixes: string[];
	opaque_re: string;
}

interface McpSecretCorpus {
	schema_version: number;
	patterns: McpSecretPatterns;
	cases: { key: string; value: string; secret: boolean; note: string }[];
	suggest: { server: string; key: string; value: string; expect_value: string; expect_var: string }[];
}

const SECRET_CORPUS = corpus as McpSecretCorpus;

/** The corpus's `key_re`/`value_re` are Python regex source, which spells a
 *  case-insensitive match as a leading `(?i)` inline-flag group — invalid JS
 *  regex syntax. Strip it and compile with the `i` flag instead. */
function compilePythonRegex(source: string): RegExp {
	if (source.startsWith("(?i)")) return new RegExp(source.slice(4), "i");
	return new RegExp(source);
}

const SECRET_KEY_RE = compilePythonRegex(SECRET_CORPUS.patterns.key_re);
const SECRET_VALUE_RE = compilePythonRegex(SECRET_CORPUS.patterns.value_re);
const SECRET_PREFIXES = SECRET_CORPUS.patterns.prefixes;
const SECRET_OPAQUE_RE = compilePythonRegex(SECRET_CORPUS.patterns.opaque_re);

/** An exact bare shell/percent reference (`$NAME`, `%NAME%`) — catalogue E06:
 *  never a literal secret, even though it carries no `${…}` wrapper. */
const SHELL_REF_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const PERCENT_REF_RE = /^%[A-Za-z_][A-Za-z0-9_]*%$/;

/** A recognized auth SCHEME with nothing (or only whitespace) after it —
 *  catalogue H02: `"Bearer"` / `"Bearer "` carries no credential yet.
 *  N7/§2.7: `bearer`/`basic` are real HTTP auth scheme words; `token` is
 *  NOT — a bare `"token"` value is an ordinary (and, next to a key like
 *  `Authorization`, suspicious) word, not a scheme with nothing after it. */
const SCHEME_ONLY_RE = /^(bearer|basic)\s*$/i;

/** True when `value` carries no `${…}` reference and looks like a credential
 *  — by key name, by value shape (`Bearer <token>`), by a known vendor
 *  prefix, or by looking sufficiently opaque. Mirrors `mcp_spec.looks_like_secret`
 *  exactly (same corpus, same rule order, same E06/H02 exemptions). */
export function looksLikeSecret(key: string, value: string | undefined | null): boolean {
	if (typeof value !== "string" || !value) return false;
	if (value.includes("${")) return false;
	if (SHELL_REF_RE.test(value) || PERCENT_REF_RE.test(value)) return false;
	if (SCHEME_ONLY_RE.test(value)) return false;
	if (typeof key === "string" && SECRET_KEY_RE.test(key)) return true;
	if (SECRET_VALUE_RE.test(value)) return true;
	if (SECRET_PREFIXES.some((p) => value.startsWith(p))) return true;
	if (SECRET_OPAQUE_RE.test(value)) return true;
	return false;
}

/** Splits a `literalSecretKeysOf`/`secret_keys_in_spec` key token back into
 *  the bare header/env/query-param name, mirroring
 *  `hub_cli.mcp._secret_value_for_key`. Every reader of one of these tokens
 *  (the New sheet's plaque, the Library band, `suggestRef`) must run it
 *  through here first — a raw `url.query:token` token is neither a real
 *  header/env key nor safe to show, and W5's finding was exactly a reader
 *  that skipped this step. */
export function bareKeyOf(key: string): { bare: string; isQuery: boolean } {
	if (key.startsWith("url.query:")) return { bare: key.slice("url.query:".length), isQuery: true };
	return { bare: key, isQuery: false };
}

/** Every header key, env key, and `url.query:<key>` token whose value trips
 *  `looksLikeSecret` (mirrors `mcp_spec.secret_keys_in_spec`). A malformed
 *  `url` is treated as carrying no query params (URL parsing is lenient by
 *  design here — the panel's job is to warn, not to validate the URL). */
export function literalSecretKeysOf(spec: McpSpec): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(spec.headers ?? {})) {
		if (looksLikeSecret(k, v)) out.push(k);
	}
	for (const [k, v] of Object.entries(spec.env ?? {})) {
		if (looksLikeSecret(k, v)) out.push(k);
	}
	if (spec.url) {
		try {
			const u = new URL(spec.url);
			for (const [k, v] of u.searchParams.entries()) {
				if (looksLikeSecret(k, v)) out.push(`url.query:${k}`);
			}
		} catch {
			/* not an absolute URL (a bare host, a template) — no query to scan */
		}
	}
	return out;
}

/** A leading auth scheme `suggestRef` preserves verbatim (mirrors
 *  `mcp_spec._AUTH_SCHEME_RE`). */
const AUTH_SCHEME_RE = /^(Bearer|Basic|Token)\s+/i;

function upperSnake(text: string): string {
	return text
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
}

export interface SuggestedRef {
	/** The replacement value — the kept scheme (if any) plus `${VAR}`. */
	value: string;
	/** The suggested `${VAR}` name, `<SERVER>_<KEY>` upper-snake (`Authorization`
	 *  becomes `TOKEN`, m5). */
	varName: string;
}

/** The `${VAR}` replacement `hub mcp add|set` offers for a literal secret
 *  (m5). Mirrors `mcp_spec.suggest_ref` exactly — corpus-pinned (case 4). */
export function suggestRef(serverName: string, key: string, value: string): SuggestedRef {
	const m = AUTH_SCHEME_RE.exec(value ?? "");
	const scheme = m ? m[0] : "";
	const keyPart = key.trim().toLowerCase() === "authorization" ? "TOKEN" : upperSnake(key);
	const varName = upperSnake(`${serverName}_${keyPart}`);
	return { value: `${scheme}\${${varName}}`, varName };
}

// ─── copy tables (F3, M5) ─────────────────────────────────────────────────────

/** One line per `McpDeliveryReason` (INTERFACES §4 / plans/E1.md §4.5's
 *  "complete map"), substituting `<detail>` where the reason carries one.
 *  `source_disabled` is intentionally ABSENT (dropped from the wave-C
 *  contract) — case 5 in `mcpContract.test.ts` asserts it stays gone. */
export const MCP_DELIVERY_REASON_COPY: Record<McpDeliveryReason, (detail: string | null) => string> = {
	affinity: () => "This server's reach does not include this harness.",
	no_global_target: () =>
		"This harness has no user-level MCP config — equip the server on a project instead.",
	not_hub_owned: () =>
		"A server with this name was already in that file and Skill Tree did not write it.",
	adapter_missing: () => "Skill Tree has no MCP writer for this harness.",
	parse_aborted: () => "That config file could not be parsed, so it was left untouched.",
	claude_project_not_approved: () =>
		"Claude Code has not approved this project server yet. Open the project in Claude Code and accept it.",
	codex_untrusted_project: () =>
		"Codex only reads a project config in a trusted folder. Trust the folder in Codex.",
	codex_no_sse: () => "Codex cannot use an SSE server.",
	codex_header_not_representable: (detail) =>
		`Codex cannot express the ${detail ?? "?"} header as a reference. It was left out.`,
	codex_env_not_representable: (detail) =>
		`Codex cannot rename an environment variable. ${detail ?? "?"} was left out.`,
	opencode_default_dropped: (detail) =>
		`opencode cannot express a default for the ${detail ?? "?"} reference. It was left out.`,
};

/** The delivery-row copy line, `<detail>` substituted where present. `null`
 *  reason (nothing to explain) renders no line — callers check for `null`
 *  themselves before calling this.
 *
 *  W1: `reason` is typed as the closed union, but the bytes actually come
 *  from a CLI that can be a different version than this app — the type
 *  proves nothing about the JSON at runtime (this exact vocabulary already
 *  churned once mid-flight, `source_disabled`). An unrecognized word falls
 *  back to itself rather than calling `undefined` and throwing. */
export function deliveryReasonLine(reason: string, detail: string | null): string {
	const fn = (MCP_DELIVERY_REASON_COPY as Record<string, ((d: string | null) => string) | undefined>)[
		reason
	];
	return fn ? fn(detail) : reason;
}

/** One line per doctor finding id this wave owns the copy for (INTERFACES §5).
 *  Placeholders (`<VAR>`, `<server>`, `<file>`, `N`) are documentation-only
 *  here — the drawer that substitutes them lives outside E1's allowed files
 *  (see the E1 report's Deviations). Case 7b's completeness test asserts
 *  every id below has a non-empty line. */
export const MCP_DOCTOR_FINDING_COPY: Record<string, string> = {
	MCP_PROJECT_SERVER_NOT_APPROVED: "Claude Code has not approved this project server.",
	MCP_CODEX_PROJECT_UNTRUSTED:
		"Codex will not read this project's config until you trust the folder.",
	MCP_NO_GLOBAL_TARGET:
		"This harness has no user-level MCP file, so a global server cannot reach it.",
	MCP_UNRESOLVED_SECRET_REF: "<VAR> is not set where Skill Tree can see it.",
	MCP_LITERAL_SECRET: "<server> stores a token in plain text. It is excluded from backups.",
	MCP_UNCLAIMED_NATIVE_ENTRY:
		"<server> is in your registry and in <file>, but Skill Tree did not write that copy.",
	MCP_PROBE_STALE: "N MCP servers have not been checked recently.",
};

/** One line + status-badge tone per `McpProbeState` (INTERFACES §3 / plans/E1.md
 *  §4.5's Check-control table). `unresolved_ref` and `unreachable` carry extra
 *  context the caller renders as a SECOND line — this returns only the
 *  primary one; callers add the shell-visibility / error detail line
 *  themselves from the probe row. */
export function probeStateLine(probe: McpProbe): {
	text: string;
	tone: BadgeChannel;
	/** Secondary context the caller may render quieter than `text`. Present
	 *  only where the state HAS a subordinate fact; a caller that ignores it
	 *  still shows a complete, honest line. */
	detail?: string;
} {
	switch (probe.state) {
		case "ok": {
			// No tool count here, deliberately. `probe.tool_count` is
			// `len(tool_names)` from the single liveness `tools/list`
			// (`mcp_probe.py`), while the catalogue pages to `ITEM_LIMIT` /
			// `PAGE_LIMIT` — so on any paginating server the two numbers
			// legitimately disagree, and printing both on one screen is a
			// contradiction, not a redundancy. DELIVERY answers "is it alive";
			// CAPABILITIES owns every count and is the one that can be browsed.
			const latency = probe.latency_ms != null ? `${probe.latency_ms} ms` : null;
			return {
				text: "Answered",
				tone: "ok",
				...(latency ? { detail: latency } : {}),
			};
		}
		case "unresolved_ref": {
			const names = probe.unresolved_refs.join(", ") || "A variable";
			return {
				text: `${names} ${probe.unresolved_refs.length === 1 ? "is" : "are"} not set in your shell environment, so the check did not run.`,
				tone: "info",
			};
		}
		case "unreachable":
			return { text: "Could not reach the server.", tone: "error" };
		case "protocol_error":
			return { text: "The server answered, but not with MCP.", tone: "error" };
		case "timeout":
			return { text: "No answer within 10 s.", tone: "error" };
		case "unsupported":
			return { text: "Skill Tree cannot check this transport.", tone: "neutral" };
		default:
			// W1: an unrecognized probe state (a newer `hub` than this app
			// knows about) degrades to a neutral line instead of destructuring
			// `undefined` and throwing.
			return { text: "Skill Tree does not recognise this result.", tone: "neutral" };
	}
}

// ─── catalogue copy (plans/G.md §6.1/§6.3, rev 3 §11.4) ──────────────────────
// Every rendered word for the CAPABILITIES block and the browse sheet lives
// here, same convention as the rest of this file.

const CATALOG_KIND_ORDER: McpCatalogKind[] = ["tools", "resources", "resource_templates", "prompts"];

const CATALOG_KIND_LABEL: Record<McpCatalogKind, { singular: string; plural: string }> = {
	tools: { singular: "tool", plural: "tools" },
	resources: { singular: "resource", plural: "resources" },
	resource_templates: { singular: "template", plural: "templates" },
	prompts: { singular: "prompt", plural: "prompts" },
};

/** `"object[]"`, `"string|null"`, `"—"` for a `null` type (§5.7/§6.1) — an
 *  array's own `type` field is always the literal string `"array"`; its
 *  element type rides the separate `items_type`. */
export function parameterTypeLabel(p: McpToolParameter): string {
	if (p.type == null) return "—";
	if (p.type === "array") return `${p.items_type ?? "any"}[]`;
	return p.type;
}

/** The glance block's counts line (§6.4). Omits a kind the server does not
 *  offer; renders `"<kind>: unknown"` for a kind whose fetch errored — never
 *  a lying `"0 resources"` for a kind we failed to read (grill F12). `""`
 *  when nothing is offered at all — callers gate display of this line on
 *  `catalogEmptyReason` returning `null` first, so that case does not need a
 *  fallback string here. */
export function capabilityCountsLine(summary: McpCatalogSummary): string {
	const parts: string[] = [];
	for (const kind of CATALOG_KIND_ORDER) {
		if (summary.unknown.includes(kind)) {
			parts.push(`${CATALOG_KIND_LABEL[kind].plural}: unknown`);
			continue;
		}
		if (!summary.offered[kind]) continue;
		const n = summary[kind];
		const label = n === 1 ? CATALOG_KIND_LABEL[kind].singular : CATALOG_KIND_LABEL[kind].plural;
		parts.push(`${n} ${label}`);
	}
	return parts.join(" · ");
}

/** One line per real catalogue-fetch fault (§6.1) — a JSON-RPC `-32601`
 *  ("Method not found") never reaches this: it is recorded as an absence
 *  (`offered[kind] = false`), never a `fetch_errors` entry (§5.4). */
const CATALOG_METHOD_LABEL: Record<string, string> = {
	"tools/list": "tools",
	"resources/list": "resources",
	"resources/templates/list": "resource templates",
	"prompts/list": "prompts",
};

export function catalogFetchErrorLine(err: McpCatalogFetchError): string {
	const label = CATALOG_METHOD_LABEL[err.method] ?? err.method;
	return `Could not read ${label}: ${err.error}`;
}

/** `"Showing the first <n> <kind>. More were left out."` — the sheet's own
 *  read of the record's `truncated`/`parameters_truncated` flags, `n` being
 *  the count actually included rather than a hardcoded limit. */
export function truncationLine(kind: McpCatalogKind, n: number): string {
	return `Showing the first ${n} ${CATALOG_KIND_LABEL[kind].plural}. More were left out.`;
}

/** §6.3's precedence table, top to bottom — the one place that decides
 *  whether the CAPABILITIES block/sheet has anything honest to show instead
 *  of the counts line. `catalog` is the SHEET's own `hub mcp catalog --json`
 *  result; the glance block never fetches the full record, so it always
 *  calls this with `catalog` omitted — only the sheet can tell "summary
 *  present, file missing" apart from every earlier row. */
export function catalogEmptyReason(
	probe: McpProbe | null | undefined,
	catalog?: McpCatalogPayload | null,
): string | null {
	if (!probe) {
		return "Not checked yet. Check the connection above to read what this server offers.";
	}
	switch (probe.state) {
		case "unresolved_ref":
			// `probe()` short-circuits before spawning anything (mcp_probe.py:563-570).
			return "The check did not run, so nothing was read.";
		case "unsupported":
			return "Skill Tree cannot read a catalogue over this transport.";
		case "unreachable":
		case "protocol_error":
		case "timeout":
			return "The last check did not reach the server, so there is nothing to list.";
		case "ok":
			break;
		default:
			// W1: an unrecognized probe state (a newer `hub`) degrades honestly
			// rather than reading `undefined.catalog` below.
			return "This check did not read the server's catalogue.";
	}
	const summary = probe.catalog;
	if (summary == null) {
		return "This check did not read the server's catalogue.";
	}
	if (catalog && !catalog.ok && catalog.code === "no_catalog") {
		return "The stored catalogue is gone. Check again to read it.";
	}
	const allEmpty = CATALOG_KIND_ORDER.every(
		(kind) => !summary.offered[kind] || (!summary.unknown.includes(kind) && summary[kind] === 0),
	);
	if (allEmpty && summary.errors === 0) {
		return "This server answered but offers no tools, resources or prompts.";
	}
	return null;
}

export interface TitledLabel {
	primary: string;
	secondary: string | null;
}

/** Rev 3 §11.4 — `title` wins as the primary label when present and
 *  different from `name`; `name` is then kept as a secondary wire-name
 *  suffix so neither is ever silently hidden. No secondary when they match,
 *  or when no title was declared at all — never an empty slot. */
export function titledLabel(name: string, title: string | null | undefined): TitledLabel {
	if (title && title !== name) return { primary: title, secondary: name };
	return { primary: name, secondary: null };
}

// ─── tool annotations (rev 3 §11.6) ───────────────────────────────────────────

/** The title every annotation chip carries — the MCP spec is explicit these
 *  are untrusted hints a client must not make security decisions from. */
export const ANNOTATION_HINT_TITLE = "The server declares this. Skill Tree does not verify it.";

const ANNOTATION_LABEL: Record<keyof McpToolAnnotations, [whenTrue: string, whenFalse: string]> = {
	read_only: ["read-only", "not read-only"],
	destructive: ["destructive", "not destructive"],
	idempotent: ["idempotent", "not idempotent"],
	open_world: ["open-world", "closed-world"],
};

/** One chip per DECLARED (non-`null`) hint — a declared `false` still
 *  renders, as its negative wording, since "declared false" is real
 *  information distinct from silence; only `null` (not declared) renders
 *  nothing. `[]` when `annotations` is absent or every hint is `null`
 *  (rev 3 §11.6: "all-null renders nothing"). */
export function annotationChips(
	annotations: McpToolAnnotations | null | undefined,
): { key: keyof McpToolAnnotations; label: string }[] {
	if (!annotations) return [];
	const out: { key: keyof McpToolAnnotations; label: string }[] = [];
	for (const key of Object.keys(ANNOTATION_LABEL) as (keyof McpToolAnnotations)[]) {
		const value = annotations[key];
		if (value == null) continue;
		const [whenTrue, whenFalse] = ANNOTATION_LABEL[key];
		out.push({ key, label: value ? whenTrue : whenFalse });
	}
	return out;
}
