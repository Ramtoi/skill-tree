import { useEffect, useMemo, useState } from "react";
import { estimateTokens, estimateTokensFromBytes } from "@/lib/estimateTokens";

// Cheap UTF-8 byte length for the live (approximate) token estimate — a single
// linear pass, unlike a full BPE encode (B3-03).
const TOKEN_BYTE_ENCODER = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function byteLength(text: string): number {
	if (!text) return 0;
	return TOKEN_BYTE_ENCODER ? TOKEN_BYTE_ENCODER.encode(text).length : text.length;
}

// Mirror what build_skill_document writes to disk (registry.rs) so the "total"
// estimate matches the on-disk document:
//   ---\nname: <name>\ndescription: |\n  <indented>\n---\n\n<body>\n
function composeDocForTokens(name: string, description: string, content: string): string {
	const indented = description.trim()
		? description
				.trimEnd()
				.split("\n")
				.map((line) => (line === "" ? "  " : `  ${line}`))
				.join("\n")
		: "  ";
	const fm = `---\nname: ${name.trim()}\ndescription: |\n${indented}\n---\n\n`;
	return fm + content.trimEnd() + "\n";
}

export interface SkillTokenEstimate {
	descTokens: number;
	bodyTokens: number;
	totalTokens: number;
}

/**
 * Live token counters for the skill editor's footer. Every keystroke pays for
 * only the cheap byte-length approximation; the exact `encode()` runs on a
 * 300ms trailing debounce, so a fast typist never pays for a full BPE encode
 * per character (B3-03).
 */
export function useSkillTokenEstimate(
	name: string,
	description: string,
	content: string,
): SkillTokenEstimate {
	const descApprox = useMemo(() => estimateTokensFromBytes(byteLength(description)), [description]);
	const bodyApprox = useMemo(() => estimateTokensFromBytes(byteLength(content)), [content]);
	const totalApprox = useMemo(
		() => estimateTokensFromBytes(byteLength(composeDocForTokens(name, description, content))),
		[name, description, content],
	);

	const [exactTokens, setExactTokens] = useState<{
		key: string;
		desc: number;
		body: number;
		total: number;
	} | null>(null);
	const tokenKey = JSON.stringify([name, description, content]);
	useEffect(() => {
		const handle = setTimeout(() => {
			setExactTokens({
				key: tokenKey,
				desc: estimateTokens(description),
				body: estimateTokens(content),
				total: estimateTokens(composeDocForTokens(name, description, content)),
			});
		}, 300);
		return () => clearTimeout(handle);
	}, [tokenKey, name, description, content]);

	const exactCurrent = exactTokens?.key === tokenKey;
	return {
		descTokens: exactCurrent ? exactTokens!.desc : descApprox,
		bodyTokens: exactCurrent ? exactTokens!.body : bodyApprox,
		totalTokens: exactCurrent ? exactTokens!.total : totalApprox,
	};
}
