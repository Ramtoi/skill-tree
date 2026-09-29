import { useEffect, useRef } from "react";
import type { DocMode } from "@/components/DocumentEditorShell";
import { isExternalManaged } from "@/lib/skillSource";
import { SKILL_MD } from "@/lib/skillFileTree";
import type { Skill } from "@/types";

/**
 * R1 — a source-managed (readOnly) or dropped skill opens on Preview when the
 * active file is markdown: source sync owns the file, so editing it is a dead
 * mode. This applies ONCE per skill route, the first moment readOnly/dropped
 * is knowable (the registry has loaded) — never again on a later registry
 * refetch, which must not yank the user back to Preview after they picked a
 * different mode themselves. The ref remembers which route already got its
 * default; comparing it against the current route is itself the "reset" (a
 * new route never equals the last-defaulted one).
 *
 * `activeRel` gates the check rather than a caller-computed "is markdown"
 * flag: on a route change the active file resets to SKILL.md (always
 * markdown) via its own effect, and reading `activeRel` here — instead of
 * trusting it to have already landed — lets this hook fire correctly even
 * when it runs a beat before that reset commits.
 */
export function useDefaultPreviewMode(params: {
	routeName: string | undefined;
	registryLoaded: boolean;
	activeRel: string;
	skill: Skill | undefined;
	dropped: boolean;
	setMode: (m: DocMode) => void;
}) {
	const { routeName, registryLoaded, activeRel, skill, dropped, setMode } = params;
	const defaultedRouteRef = useRef<string | null>(null);
	useEffect(() => {
		if (!routeName || !registryLoaded) return;
		if (activeRel !== SKILL_MD) return;
		if (defaultedRouteRef.current === routeName) return;
		defaultedRouteRef.current = routeName;
		if (isExternalManaged(skill) || dropped) setMode("preview");
	}, [routeName, registryLoaded, activeRel, skill, dropped, setMode]);
}
