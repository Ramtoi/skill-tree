// ─── Real aligned line diff (D2) ──────────────────────────────────────────────
// Common prefix/suffix trim → Myers O(ND) shortest-edit-script on the changed
// middle → ops with line numbers → hunks with `@@` headers. No dependency.
// Content-agnostic: frontmatter-awareness lives at the call site (compose the
// synthesized document and pass it as `original`/`current`).

export type DiffOp = {
	kind: " " | "-" | "+";
	text: string;
	aLine?: number;
	bLine?: number;
};

export interface DiffHunk {
	header: string; // "@@ -aStart,aCount +bStart,bCount @@"
	ops: DiffOp[];
}

interface Edit {
	kind: " " | "-" | "+";
	aIndex?: number;
	bIndex?: number;
}

/** Myers shortest-edit-script over two line arrays (James Coglan's formulation). */
function myers(a: string[], b: string[]): Edit[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	if (max === 0) return [];
	const v: Record<number, number> = { 1: 0 };
	const trace: Array<Record<number, number>> = [];
	let done = false;
	for (let d = 0; d <= max && !done; d++) {
		trace.push({ ...v });
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v[k - 1] ?? -1) < (v[k + 1] ?? -1))) {
				x = v[k + 1] ?? 0;
			} else {
				x = (v[k - 1] ?? 0) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k] = x;
			if (x >= n && y >= m) {
				done = true;
				break;
			}
		}
	}

	// Backtrack through the trace to recover the edit sequence.
	const edits: Edit[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vd = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && (vd[k - 1] ?? -1) < (vd[k + 1] ?? -1))) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = vd[prevK] ?? 0;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			edits.push({ kind: " ", aIndex: x - 1, bIndex: y - 1 });
			x--;
			y--;
		}
		if (d > 0) {
			if (x === prevX) {
				edits.push({ kind: "+", bIndex: y - 1 });
			} else {
				edits.push({ kind: "-", aIndex: x - 1 });
			}
			x = prevX;
			y = prevY;
		}
	}
	edits.reverse();
	return edits;
}

function commonPrefixLen(a: string[], b: string[]): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

function commonSuffixLen(a: string[], b: string[], prefix: number): number {
	const n = Math.min(a.length, b.length) - prefix;
	let i = 0;
	while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
	return i;
}

function groupHunks(ops: DiffOp[], context = 3): DiffHunk[] {
	const changeIdx: number[] = [];
	ops.forEach((o, i) => {
		if (o.kind !== " ") changeIdx.push(i);
	});
	if (changeIdx.length === 0) return [];

	const ranges: Array<[number, number]> = [];
	for (const ci of changeIdx) {
		const lo = Math.max(0, ci - context);
		const hi = Math.min(ops.length - 1, ci + context);
		const last = ranges[ranges.length - 1];
		if (last && lo <= last[1] + 1) {
			last[1] = Math.max(last[1], hi);
		} else {
			ranges.push([lo, hi]);
		}
	}

	return ranges.map(([lo, hi]) => {
		const slice = ops.slice(lo, hi + 1);
		const aLines = slice.filter((o) => o.aLine !== undefined);
		const bLines = slice.filter((o) => o.bLine !== undefined);
		const aStart = aLines.length ? aLines[0].aLine! : 0;
		const bStart = bLines.length ? bLines[0].bLine! : 0;
		const header = `@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`;
		return { header, ops: slice };
	});
}

export function lineDiff(original: string, current: string): DiffHunk[] {
	if (original === current) return [];
	const a = original.split("\n");
	const b = current.split("\n");

	const prefix = commonPrefixLen(a, b);
	const suffix = commonSuffixLen(a, b, prefix);

	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);
	const midEdits = myers(aMid, bMid);

	const ops: DiffOp[] = [];
	// Shared prefix → context.
	for (let k = 0; k < prefix; k++) {
		ops.push({ kind: " ", text: a[k], aLine: k + 1, bLine: k + 1 });
	}
	// Changed middle.
	for (const e of midEdits) {
		if (e.kind === " ") {
			ops.push({
				kind: " ",
				text: aMid[e.aIndex!],
				aLine: prefix + e.aIndex! + 1,
				bLine: prefix + e.bIndex! + 1,
			});
		} else if (e.kind === "-") {
			ops.push({
				kind: "-",
				text: aMid[e.aIndex!],
				aLine: prefix + e.aIndex! + 1,
			});
		} else {
			ops.push({
				kind: "+",
				text: bMid[e.bIndex!],
				bLine: prefix + e.bIndex! + 1,
			});
		}
	}
	// Shared suffix → context.
	for (let j = 0; j < suffix; j++) {
		const aIdx = a.length - suffix + j;
		const bIdx = b.length - suffix + j;
		ops.push({ kind: " ", text: a[aIdx], aLine: aIdx + 1, bLine: bIdx + 1 });
	}

	return groupHunks(ops);
}

/** True when the compared texts are identical (no hunks). */
export function isUnchanged(hunks: DiffHunk[]): boolean {
	return hunks.length === 0;
}
