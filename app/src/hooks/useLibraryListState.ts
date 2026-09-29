// Library edits compose synchronously before React Router renders navigation.
// Keep the input local so pending URL transitions cannot drop keystrokes.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import type { SearchKind } from "@/lib/unifiedSearch";
import type { ClassificationScope } from "@/lib/libraryClassification";
import type { WorkingMode } from "@/types";

export type KindFilter = "all" | SearchKind;
export type InvocationFilter =
	| "all"
	| "auto"
	| "user-only"
	| "model-only"
	| "conflicted";

const KIND_VALUES: readonly KindFilter[] = ["all", "skill", "mcp", "bundle", "snippet"];
const TRIGGER_VALUES: readonly InvocationFilter[] = [
	"all",
	"auto",
	"user-only",
	"model-only",
	"conflicted",
];
const MODE_VALUES: readonly ("all" | WorkingMode)[] = ["all", "inline", "delegator", "mixed"];

function readKind(v: string | null): KindFilter {
	return v && (KIND_VALUES as readonly string[]).includes(v) ? (v as KindFilter) : "all";
}

function readTrigger(v: string | null): InvocationFilter {
	return v && (TRIGGER_VALUES as readonly string[]).includes(v)
		? (v as InvocationFilter)
		: "all";
}
function readMode(v: string | null): "all" | WorkingMode {
	return v && (MODE_VALUES as readonly string[]).includes(v) ? (v as "all" | WorkingMode) : "all";
}
function readClassificationScope(v: string | null): ClassificationScope {
	return v === "assigned" ? "assigned" : "references";
}

interface ListValues {
	q: string;
	kind: KindFilter;
	source: string | null;
	trigger: InvocationFilter;
	classFilter: string | null;
	mode: "all" | WorkingMode;
	classificationScope: ClassificationScope;
}

/** Applies `values` onto `base` (preserving any OTHER param the URL already
 *  carries — a lingering one-shot `new=1`, say), deleting a default-valued
 *  key rather than writing it out (`q=`, `kind=all`, …). */
function applyListParams(base: URLSearchParams, values: ListValues): URLSearchParams {
	const next = new URLSearchParams(base);
	if (values.q) next.set("q", values.q);
	else next.delete("q");
	if (values.kind !== "all") next.set("kind", values.kind);
	else next.delete("kind");
	if (values.source) next.set("source", values.source);
	else next.delete("source");
	if (values.trigger !== "all") next.set("trigger", values.trigger);
	else next.delete("trigger");
	if (values.classFilter) next.set("class", values.classFilter); else next.delete("class");
	if (values.mode !== "all") next.set("mode", values.mode); else next.delete("mode");
	if (values.classificationScope !== "references") next.set("classScope", values.classificationScope); else next.delete("classScope");
	return next;
}

export interface LibraryListStatePatch {
	q?: string;
	kind?: KindFilter;
	/** `null` clears the facet; omit the key entirely to leave it untouched. */
	source?: string | null;
	trigger?: InvocationFilter;
	classFilter?: string | null;
	mode?: "all" | WorkingMode;
	classificationScope?: ClassificationScope;
}

export interface LibraryListState {
	q: string;
	kind: KindFilter;
	/** Raw URL value, NOT validated against the live source list — an id for
	 *  a source that no longer exists reads as-is here. The caller (who has
	 *  the real source list) decides what "unknown" means (H7: no facet, but
	 *  the URL keeps the dead reference rather than being silently rewritten
	 *  on mount). */
	source: string | null;
	trigger: InvocationFilter;
	classFilter: string | null;
	mode: "all" | WorkingMode;
	classificationScope: ClassificationScope;
	/** The `q`/`kind`/`source`/`trigger` list state serialized to a query
	 *  string RIGHT NOW — built from the live values (so it's correct even
	 *  before the router has rendered the latest query write) and from
	 *  an EMPTY base, so it never carries a one-shot param (`new`,
	 *  `addBundle`, `addProject`) that happens to also be in the current URL.
	 *  This is the LIST state only — use this, never `location.search`,
	 *  wherever "the list state as a string" is needed (R2's return-with-
	 *  attention referrer, which must not resurrect a one-shot sheet param). */
	search: string;
	/** Compose a patch with the latest intended values, including writes
	 *  whose router transition has not rendered. Replace the history entry
	 *  and omit default-valued keys. */
	patch: (partial: LibraryListStatePatch) => void;
}

const WRITE_STATE_KEY = "__skillHubLibraryListWrite";

interface Destination {
	pathname: string;
	search: string;
	hash: string;
	state: unknown;
}
interface ListWrite {
	owner: string;
	generation: number;
	id: number;
	pathname: string;
	search: string;
	hash: string;
}

function plainState(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object") return null;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null
		? value as Record<string, unknown> : null;
}

function readWrite(state: unknown): ListWrite | null {
	const marker = plainState(plainState(state)?.[WRITE_STATE_KEY]);
	if (!marker || typeof marker.owner !== "string"
		|| !Number.isSafeInteger(marker.generation) || !Number.isSafeInteger(marker.id)
		|| typeof marker.pathname !== "string" || typeof marker.search !== "string"
		|| typeof marker.hash !== "string") return null;
	return marker as unknown as ListWrite;
}

function readValues(params: URLSearchParams): ListValues {
	return {
		q: params.get("q") ?? "",
		kind: readKind(params.get("kind")),
		source: params.get("source"),
		trigger: readTrigger(params.get("trigger")),
		classFilter: params.get("class"),
		mode: readMode(params.get("mode")),
		classificationScope: readClassificationScope(params.get("classScope")),
	};
}

export function useLibraryListState(): LibraryListState {
	const location = useLocation();
	const navigationType = useNavigationType();
	const navigate = useNavigate();
	const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
	const values = readValues(params);
	const [q, setQ] = useState(values.q);
	const [owner] = useState(() => crypto.randomUUID());
	const intended = useRef(new URLSearchParams(params));
	const latestLocation = useRef(location);
	const observedKey = useRef(location.key);
	const generation = useRef(0);
	const writeId = useRef(0);
	const settledWrite = useRef(0);
	const firstGenerationWrite = useRef(1);
	const external = useRef<Destination>(location);

	const write = useCallback((destination: Destination) => {
		const id = ++writeId.current;
		const marker: ListWrite = {
			owner, generation: generation.current, id,
			pathname: destination.pathname, search: destination.search, hash: destination.hash,
		};
		const base = plainState(destination.state);
		// Null is the normal unadorned route. Preserve unusual state types
		// rather than wrapping or coercing a caller's array or primitive.
		const state = destination.state == null || base
			? { ...base, [WRITE_STATE_KEY]: marker }
			: destination.state;
		navigate({ pathname: destination.pathname, search: destination.search, hash: destination.hash }, { replace: true, state });
	}, [navigate, owner]);

	useLayoutEffect(() => {
		// State-only navigation matters: a return hook may have consumed a
		// one-shot referrer while leaving every search parameter unchanged.
		if (observedKey.current === location.key) return;
		observedKey.current = location.key;
		const marker = readWrite(location.state);
		const fromThisMount = marker?.owner === owner;
		const exactDestination = marker?.pathname === location.pathname
			&& marker?.search === location.search && marker?.hash === location.hash;
		const issued = marker !== null && marker.id > 0 && marker.id <= writeId.current;

		if (navigationType === "REPLACE" && fromThisMount && issued && exactDestination) {
			if (marker.generation < generation.current) {
				// A superseded transition cannot settle over a later external
				// destination. Restore its complete route, not only its query.
				write(external.current);
				return;
			}
			if (marker.generation === generation.current && marker.id >= firstGenerationWrite.current) {
				if (marker.id === writeId.current) {
					latestLocation.current = location;
					settledWrite.current = marker.id;
				} else if (marker.id < settledWrite.current) {
					// Restore only after a newer write has actually settled.
					// Earlier observations while it is pending need no extra write.
					const search = intended.current.toString();
					write({ ...latestLocation.current, search: search ? `?${search}` : "" });
				}
				return;
			}
		}

		// POP is always external, even if history retained one of our marks.
		latestLocation.current = location;
		generation.current += 1;
		settledWrite.current = 0;
		firstGenerationWrite.current = writeId.current + 1;
		intended.current = new URLSearchParams(location.search);
		external.current = location;
		setQ(intended.current.get("q") ?? "");
	}, [location, navigationType, owner, write]);

	const patch = useCallback((partial: LibraryListStatePatch) => {
		const nextValues = readValues(intended.current);
		for (const key of Object.keys(partial) as (keyof LibraryListStatePatch)[]) {
			if (partial[key] !== undefined) Object.assign(nextValues, { [key]: partial[key] });
		}
		const next = applyListParams(intended.current, nextValues);
		intended.current = next;
		setQ(nextValues.q);
		const search = next.toString();
		write({ ...latestLocation.current, search: search ? `?${search}` : "" });
	}, [write]);

	// Only list parameters belong in referrers; never copy one-shot params.
	const search = useMemo(() => {
		const next = applyListParams(new URLSearchParams(), { ...readValues(params), q }).toString();
		return next ? `?${next}` : "";
	}, [params, q]);
	return { ...values, q, search, patch };
}
