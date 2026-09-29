import { useMemo } from "react";
import { MultiSelectList } from "./MultiSelectList";
import { StatusBadge } from "./StatusBadge";
import { HarnessGlyph } from "./harness/HarnessGlyph";
import { harnessLabel } from "./harness/harnessRegistry";
import type { HookCapabilitiesCache } from "@/hooks/useHooks";
import { REACH_AFFINITY_TEXT, reachBadges, type ReachBadge } from "@/lib/hookReach";

export interface HarnessReachPanelProps {
	/** Harness ids installed on this machine (from `harness_list`). */
	installed: string[];
	/** The hook's affinity list. EMPTY = every effective harness (all toggles on). */
	affinity: string[];
	onChange: (affinity: string[]) => void;
	capabilities: HookCapabilitiesCache | null | undefined;
	/** The event currently selected in the form — reach recomputes per event. */
	event: string;
	readOnly?: boolean;
	/** Hide the explanatory sentence above the rows — the caller already carries
	 *  it elsewhere (a `SidePanelSection` head's `title`, e.g.), so a body copy
	 *  would just restate idle text as a paragraph (side panel language rule
	 *  1/9: idle information rides on `title`). The hook editor is the one
	 *  consumer today and passes `false` (AUDIT m4: this makes the `true`
	 *  branch and `.hook-harness-panel .conn-hint` dead in the shipped app
	 *  right now) — kept as the DEFAULT anyway rather than deleted, because
	 *  this component is the public, reusable "affinity toggle + reach
	 *  verdict" primitive (D1), and a future consumer rendered without a
	 *  section head of its own (a compact card, a standalone dialog) still
	 *  needs the explanation somewhere on screen. `HarnessReachPanel.test.tsx`
	 *  exercises that default directly; `hookReach.test.ts` covers the shipped
	 *  `intro={false}` path via `harnessReachHint`, which shares the exact
	 *  same three strings (`REACH_AFFINITY_TEXT`). */
	intro?: boolean;
}

/** Stable display order — the two hook-capable harnesses first (mirrors hookReach). */
const HARNESS_ORDER = ["claude-code", "codex", "opencode", "pi"];

function orderIndex(id: string): number {
	const i = HARNESS_ORDER.indexOf(id);
	return i === -1 ? HARNESS_ORDER.length : i;
}

/** The status word a row shows, matching the reach-badge vocabulary already used
 *  on the library rows so one word means one thing across the surface. */
function statusFor(
	badge: ReachBadge | undefined,
	targeted: boolean,
	capsKnown: boolean,
): { label: string; key: string; channel: "ok" | "neutral"; title?: string } {
	// Affinity wins over capability: an excluded harness is never written to, so
	// claiming "will fire" there because the PROBE says so would be a lie.
	if (!targeted) {
		return {
			label: "excluded",
			key: "excluded",
			channel: "neutral",
			title: "This hook's harness affinity excludes this harness.",
		};
	}
	if (!capsKnown) {
		return {
			label: "reach unknown",
			key: "reach unknown",
			channel: "neutral",
			title: "Run `hub sync` to probe hook capability per harness.",
		};
	}
	if (!badge) {
		return {
			label: "not installed",
			key: "not_installed",
			channel: "neutral",
			title: "This harness is not installed on this machine.",
		};
	}
	if (badge.eventUnsupported) {
		return {
			label: "event unsupported",
			key: "event unsupported",
			channel: "neutral",
			title: badge.reason,
		};
	}
	if (badge.verdict === "supported") {
		return { label: "will fire", key: "supported", channel: "ok", title: badge.reason };
	}
	if (badge.verdict === "feature_off") {
		return { label: "hooks off", key: "feature_off", channel: "neutral", title: badge.reason };
	}
	return {
		label: "unsupported",
		key: badge.verdict,
		channel: "neutral",
		title: badge.reason,
	};
}

/**
 * The ONE harness panel (hook-editor-redesign D1). Merges what used to be two
 * separate lists — the "reach for <event>" badge row in the main column and the
 * "harness affinity" chips in the side column — into one row per harness:
 *
 *     [toggle] <glyph> Claude Code            will fire
 *
 * Cause (the affinity toggle) and effect (whether the hook actually reaches that
 * harness for the selected event) sit on the same line, so the two can no longer
 * read as the same information rendered twice. Reach recomputes client-side from
 * the cached probe (no fetch), so flipping the event updates it instantly.
 */
export function HarnessReachPanel({
	installed,
	affinity,
	onChange,
	capabilities,
	event,
	readOnly,
	intro = true,
}: HarnessReachPanelProps) {
	const badges = useMemo(
		() => new Map(reachBadges(capabilities, event).map((b) => [b.harnessId, b])),
		[capabilities, event],
	);

	// Rows = installed ∪ affinity. A harness the hook targets but that is NOT
	// installed here still gets a row: it is part of the definition, and hiding
	// it is how it silently gets dropped on the next save.
	const rows = useMemo(() => {
		const ids = new Set([...installed, ...affinity]);
		return Array.from(ids).sort((a, b) => {
			const d = orderIndex(a) - orderIndex(b);
			return d !== 0 ? d : a.localeCompare(b);
		});
	}, [installed, affinity]);

	const unrestricted = affinity.length === 0;
	const capsKnown = !!capabilities?.harnesses;

	// One harness, one row: turning it off empties the set, which the model reads
	// back as "unrestricted" — so the toggle springs straight back on with no
	// explanation and nothing changes. There is no narrowing to express here, so
	// the control says why it is locked instead of pretending to be actionable.
	// (With more than one row, emptying the affinity is a real action: it widens
	// the hook back to every harness.)
	const soleHarness = installed.length === 1 && rows.length === 1;
	const soleHarnessReason =
		"The only installed harness — a hook must target at least one.";

	function toggle(id: string) {
		if (readOnly) return;
		// Seed from the CURRENT affinity (which may include a harness the hook was
		// scoped to that isn't installed on this machine — never drop that
		// silently). Only fall back to "every installed harness" when affinity was
		// empty (i.e. currently unrestricted).
		const set = new Set(affinity.length ? affinity : installed);
		if (set.has(id)) set.delete(id);
		else set.add(id);
		onChange(set.size === 0 ? [] : [...set]);
	}

	return (
		<div className="hook-harness-panel">
			{intro && (
				<p className="conn-hint">
					{soleHarness
						? REACH_AFFINITY_TEXT.soleHarness(harnessLabel(rows[0]))
						: unrestricted
							? REACH_AFFINITY_TEXT.unrestricted
							: REACH_AFFINITY_TEXT.narrowed}
				</p>
			)}
			{rows.length === 0 ? (
				<span className="text-dim">no harnesses installed</span>
			) : (
				<MultiSelectList
					label="Harnesses"
					onToggle={toggle}
					options={rows.map((id) => {
						const targeted = unrestricted || affinity.includes(id);
						const status = statusFor(badges.get(id), targeted, capsKnown);
						const notInstalled = !installed.includes(id);
						const disabled = readOnly || soleHarness;
						return {
							id,
							selected: targeted,
							disabled,
							// The lock reason wins the row's own title; the reach
							// explanation stays on the StatusBadge itself so the two
							// consequences (can't toggle / won't fire) never collide in
							// one string.
							title: disabled && soleHarness ? soleHarnessReason : undefined,
							glyph: <HarnessGlyph id={id} size={15} decorative />,
							label: (
								<>
									{harnessLabel(id)}
									{notInstalled && (
										<span className="text-dim harness-reach-note"> (not installed)</span>
									)}
								</>
							),
							meta: (
								<StatusBadge
									channel={status.channel}
									shape="dot"
									title={status.title || undefined}
									className="hook-reach-badge"
									ariaLabel={`${harnessLabel(id)}: ${status.key}`}
								>
									{status.label}
								</StatusBadge>
							),
						};
					})}
				/>
			)}
		</div>
	);
}
