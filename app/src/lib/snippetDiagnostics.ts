import type { SnippetMarkerDiagnostic } from "@/types/snippets";

const MARKER_PROBLEMS: Record<string, string> = {
	"nested-start": "nested start marker",
	"incomplete-block": "missing end marker",
	"mismatched-end": "end marker has a different snippet name",
	"duplicate-id": "duplicate snippet block",
	"unmatched-end": "end marker has no start marker",
	"malformed-token": "malformed marker comment",
	"unpaired-start": "missing end marker",
	"unpaired-end": "end marker has no start marker",
};

export function snippetMarkerProblem(kind: string): string {
	return MARKER_PROBLEMS[kind] ?? "damaged snippet marker";
}

export function snippetMarkerLine(diagnostic: SnippetMarkerDiagnostic): string {
	return `Line ${diagnostic.line}: ${snippetMarkerProblem(diagnostic.kind)}`;
}

export function snippetMarkerSaveMessage(
	diagnostics: SnippetMarkerDiagnostic[],
): string {
	if (diagnostics.length === 0) {
		return "Repair the damaged snippet marker in this editor. Then save again.";
	}
	const first = snippetMarkerLine(diagnostics[0]);
	const rest = diagnostics.length - 1;
	return rest > 0
		? `${first}. Repair this marker and ${rest} other ${rest === 1 ? "problem" : "problems"}. Then save again.`
		: `${first}. Repair this marker. Then save again.`;
}
