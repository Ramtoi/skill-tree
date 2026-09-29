import { useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Extension } from "@codemirror/state";
import { useSearchCorpus } from "@/hooks/useSearchCorpus";
import { fromNav, type BackTarget } from "@/lib/backTarget";
import {
	countRefs,
	incomingRefs,
	type SkillRefEdgeCount,
	type SkillRefRenderOptions,
} from "@/lib/skillRefs";
import { skillRefExtension } from "@/components/skillRefs/refDecorations";
import { skillRefCompletion } from "@/components/skillRefs/refCompletion";
import type { Registry } from "@/types";

/** Who is asking. One object per host; what varies between the five
 *  editors. */
export interface SkillRefsHost {
	/** Where a reference click returns to. Every host builds its own with a
	 *  `lib/backTarget.ts` helper. May be an inline literal — the hook
	 *  memoizes on this object's VALUES, never its identity (see `backKey`). */
	back: BackTarget;
	/** The skill this buffer IS, when the host is the skill editor. Excluded
	 *  from its own mentions, and the ONLY thing that turns on `refs_ignore`
	 *  and `mentionedBy`. Absent for every doc host. */
	self?: string;
	/** Wraps the navigation a reference click performs — a host with a leave
	 *  guard passes its `bypass`. */
	wrapNavigate?: (go: () => void) => void;
}

export interface SkillRefsView {
	/** Outgoing references from the live editor buffer, sorted by name. */
	mentions: SkillRefEdgeCount[];
	/** Incoming references from the last-saved search corpus, sorted by name.
	 *  ALWAYS `[]` when `host.self` is absent — a doc is not in the corpus. */
	mentionedBy: SkillRefEdgeCount[];
	/** This skill's `refs_ignore` entries that the live buffer actually
	 *  mentions. `[]` when `host.self` is absent. */
	ignored: string[];
	/** CodeMirror extension bundle: decoration, hover, ⌘-click, AND the
	 *  slash-reference completion overlay. Referentially stable across
	 *  `content` changes, across a re-created inline `host.back` literal, AND
	 *  across a `back.restore` payload that changes on every keystroke.
	 *
	 *  Every caller of `useSkillRefs` builds this bundle, so
	 *  `SkillRefsSection` — which only needs `mentions`/`mentionedBy` — also
	 *  constructs an `autocompletion()` it never mounts. It is memoized on
	 *  `render`, and constructing a CM extension allocates a handful of
	 *  objects, so this is cheap and deliberate; the alternative (a lazy
	 *  `extension` getter, or a second hook) would trade one clear contract
	 *  for two. */
	extension: Extension;
	/** Shared render options — same stability contract as `extension`. */
	render: SkillRefRenderOptions;
}

const NO_IGNORE: readonly string[] = [];
const NO_EDGES: SkillRefEdgeCount[] = [];
const NO_NAMES: string[] = [];

function sortEdges(counts: Record<string, number>): SkillRefEdgeCount[] {
	return Object.keys(counts)
		.map((name) => ({ name, count: counts[name] }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Identity key for a back target. `restore` is DELIBERATELY EXCLUDED: the
 *  snippet create form's draft payload (F11) changes on every keystroke, and
 *  including it would reconfigure the CodeMirror extra-extensions compartment
 *  on every keystroke in that editor. `onOpen` reads the live object through
 *  `backRef` at click time, so the newest `restore` is always what travels —
 *  identity does not have to change for the payload to be current. */
function backKey(b: BackTarget): string {
	return JSON.stringify([b.label, b.path, b.crumbs ?? null]);
}

/**
 * Joins the live editor buffer, the registry and the search corpus into one
 * `SkillRefsView`. Called twice — once by the host editor for the editor and
 * preview extensions, once by `SkillRefsSection` for the panel — and holds no
 * mutable state, so the two calls can never disagree.
 *
 * `render`/`extension` are memoized over `(names, self, ignore, describe,
 * onOpen)` and NEVER over `content`, so `extension` stays referentially
 * stable across keystrokes (the CodeMirror compartment must not be
 * reconfigured while typing). `onOpen` is memoized over `(navigate, key)`
 * where `key = backKey(host.back)` — a fresh inline `host.back` literal every
 * render does not change `key`, so passing `host` as an inline literal is
 * safe. `mentions` is memoized over `(content, names, self, ignore)`.
 * `mentionedBy` is memoized over `(corpus, registry, self)` and short-
 * circuits to `NO_EDGES` when `self` is absent — a doc host is not in the
 * search corpus. `ignored` short-circuits to `NO_NAMES` when `self` is absent
 * or `ignore` is empty.
 */
export function useSkillRefs(args: {
	host: SkillRefsHost;
	content: string;
	registry: Registry | undefined;
}): SkillRefsView {
	const { host, content, registry } = args;
	const self = host.self;
	const navigate = useNavigate();
	const corpusQuery = useSearchCorpus();
	const corpus = corpusQuery.data?.skills;

	const names = useMemo(
		() => Object.keys(registry?.skills ?? {}),
		[registry],
	);
	const ignore = useMemo(
		() => (self ? (registry?.skills[self]?.refs_ignore ?? NO_IGNORE) : NO_IGNORE),
		[registry, self],
	);

	const describe = useCallback(
		(name: string) => registry?.skills[name]?.description,
		[registry],
	);

	const hostRef = useRef(host);
	hostRef.current = host; // always current, never a dep
	const key = backKey(host.back); // the only dep that can change

	const onOpen = useCallback(
		(name: string) => {
			void key; // F14: consumed so `react-hooks/exhaustive-deps` sees no
			// "unnecessary dependency" warning — lint is capped at 88.
			const go = () =>
				navigate(`/skill/${encodeURIComponent(name)}`, fromNav(hostRef.current.back));
			const wrap = hostRef.current.wrapNavigate;
			if (wrap) wrap(go);
			else go();
		},
		[navigate, key],
	);

	const render = useMemo<SkillRefRenderOptions>(
		() => ({ names, self, ignore, describe, onOpen }),
		[names, self, ignore, describe, onOpen],
	);

	// Never keyed on `content` — see the doc comment above.
	const extension = useMemo(
		() => [skillRefExtension(render), skillRefCompletion(render)],
		[render],
	);

	const mentions = useMemo<SkillRefEdgeCount[]>(
		() => sortEdges(countRefs(content, names, self, ignore)),
		[content, names, self, ignore],
	);

	const mentionedBy = useMemo<SkillRefEdgeCount[]>(() => {
		if (!self || !corpus) return NO_EDGES;
		return incomingRefs(
			corpus,
			self,
			names,
			(referrer) => registry?.skills[referrer]?.refs_ignore ?? [],
		);
	}, [corpus, registry, self, names]);

	const ignored = useMemo(() => {
		if (!self || ignore.length === 0) return NO_NAMES;
		const counts = countRefs(content, ignore, self);
		return ignore.filter((name) => (counts[name] ?? 0) > 0).sort();
	}, [content, ignore, self]);

	return { mentions, mentionedBy, ignored, extension, render };
}
