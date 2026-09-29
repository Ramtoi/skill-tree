import { useEffect, useRef, useState } from "react";

export interface TokenSummary {
	upfront: number;
	discoverable: number;
}

export interface TokenPulse {
	pulseUpfront: boolean;
	pulseDisc: boolean;
}

/** Pulse the upfront / discoverable cell when its value changes meaningfully
 *  (≥50 tokens absolute or ≥10% relative). First-data-arrival is not a pulse
 *  — `ready` gates that (the caller passes whether its listing data has
 *  arrived yet). Extracted verbatim from AgentDocsView. */
export function useTokenPulse(ready: boolean, summary: TokenSummary): TokenPulse {
	const tokenBaselineRef = useRef<TokenSummary | null>(null);
	const [pulseUpfront, setPulseUpfront] = useState(false);
	const [pulseDisc, setPulseDisc] = useState(false);
	useEffect(() => {
		if (!ready) return;
		const baseline = tokenBaselineRef.current;
		if (!baseline) {
			tokenBaselineRef.current = summary;
			return;
		}
		const isBig = (prev: number, curr: number) => {
			if (prev === curr) return false;
			const delta = Math.abs(curr - prev);
			if (delta >= 50) return true;
			const base = Math.max(prev, 1);
			return delta / base >= 0.1;
		};
		if (isBig(baseline.upfront, summary.upfront)) {
			setPulseUpfront(true);
			const t = setTimeout(() => setPulseUpfront(false), 1100);
			tokenBaselineRef.current = summary;
			return () => clearTimeout(t);
		}
		if (isBig(baseline.discoverable, summary.discoverable)) {
			setPulseDisc(true);
			const t = setTimeout(() => setPulseDisc(false), 1100);
			tokenBaselineRef.current = summary;
			return () => clearTimeout(t);
		}
		tokenBaselineRef.current = summary;
	}, [ready, summary]);

	return { pulseUpfront, pulseDisc };
}
