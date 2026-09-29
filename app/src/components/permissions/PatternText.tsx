/**
 * Splits a registry pattern (`Bash(npm:*)`) into its tool prefix and inner
 * argument text so the reconcile dialog can dim the boilerplate and let the
 * part that actually varies stand out. A pattern without a `tool(...)` shape
 * (or with mismatched parens) renders whole in `.inner`.
 */
export function splitPattern(pattern: string): {
	tool: string | null;
	inner: string;
} {
	const m = /^([A-Za-z_]+)\((.*)\)$/.exec(pattern);
	if (!m) return { tool: null, inner: pattern };
	return { tool: m[1], inner: m[2] };
}

export function PatternText({ pattern }: { pattern: string }) {
	const { tool, inner } = splitPattern(pattern);
	if (tool === null) {
		return (
			<code className="reconcile-pattern">
				<span className="inner">{pattern}</span>
			</code>
		);
	}
	return (
		<code className="reconcile-pattern">
			<span className="tool">{tool}(</span>
			<span className="inner">{inner}</span>
			<span className="tool">)</span>
		</code>
	);
}
