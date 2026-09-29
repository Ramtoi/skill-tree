import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { asciiIdentity, type ClassificationContribution, type ContributionProvenance } from "@/lib/skillClassification";

const provenanceLabel: Record<ContributionProvenance, string> = {
	assigned: "Assigned",
	direct: "Direct reference",
	indirect: "Indirect reference",
};

export interface ClassificationValueProps {
	value: string;
	provenance?: ContributionProvenance;
	field?: "classes" | "outputs";
	onInspect?: (field: "classes" | "outputs", value: string) => void;
	children?: ReactNode;
}

export function ClassificationValue({ value, provenance, field, onInspect, children }: ClassificationValueProps) {
	const content = <span className="classification-value-label">{children ?? value}</span>;
	if (!onInspect) return <span className={`classification-value classification-value-${provenance ?? "assigned"}`} title={value}>{content}</span>;
	return (
		<button
			type="button"
			className={`classification-value classification-value-${provenance ?? "assigned"}`}
			title={`${value}${provenance ? ` · ${provenanceLabel[provenance]}` : ""}`}
			aria-label={`${value}${provenance ? `, ${provenanceLabel[provenance]}` : ""}`}
			onClick={(event) => { event.stopPropagation(); onInspect(field ?? "outputs", value); }}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") event.stopPropagation();
			}}
		>
			{content}
		</button>
	);
}

export interface OutputFlowProps {
	outputs: ClassificationContribution[] | string[];
	onInspect?: (field: "classes" | "outputs", value: string) => void;
	onRemove?: (value: string) => void;
	compact?: boolean;
}

export interface ContributionPathInspectorProps {
	value: string;
	contributors: string[];
	paths?: string[][];
	hasMore?: boolean;
	onOpenContributor?: (name: string) => void;
	onLoadMore?: () => void;
}

/** Lazy path surface owned by the caller: the summary never computes paths. */
export function ContributionPathInspector({ value, contributors, paths = [], hasMore, onOpenContributor, onLoadMore }: ContributionPathInspectorProps) {
	return <div className="classification-path-inspector" aria-label={`Contributors for ${value}`}>
		<strong>{value}</strong>
		<span className="text-dim">References show connections; they do not confirm execution.</span>
		{contributors.length > 0 && <div className="classification-contributors">{contributors.map((name) => onOpenContributor ? <button type="button" key={name} onClick={() => onOpenContributor(name)}>{name}</button> : <span key={name}>{name}</span>)}</div>}
		{paths.map((path, index) => <div className="classification-path" key={`${value}-${index}`}>{path.join(" → ")}</div>)}
		{hasMore && onLoadMore && <button type="button" onClick={onLoadMore}>Load more paths</button>}
	</div>;
}

function contribution(value: ClassificationContribution | string): ClassificationContribution {
	return typeof value === "string" ? { value, provenance: "assigned", contributors: [] } : value;
}

/** One continuous produces flow. Values are buttons so keyboard users can inspect paths. */
export function OutputFlow({ outputs, onInspect, onRemove, compact }: OutputFlowProps) {
	if (outputs.length === 0) return null;
	const ordered = [...outputs].sort((a, b) => {
		const rank = (value: string) => ({ prompt: 0, plan: 1, "code change": 2, pr: 3 }[asciiIdentity(value)] ?? 4);
		return rank(contribution(a).value) - rank(contribution(b).value);
	});
	return (
		<div className={`output-flow${compact ? " output-flow-compact" : ""}`} aria-label="Produces">
			<span className="output-flow-leading" aria-hidden="true"><Icon name="output" size={13} /></span>
			{ordered.map((raw, index) => {
				const item = contribution(raw);
				return (
					<span className="output-flow-item" key={`${item.value}-${index}`}>
						{index > 0 && <span className="output-flow-separator" aria-hidden="true" />}
						<ClassificationValue field="outputs" value={item.value} provenance={item.provenance} onInspect={onInspect} />
						{item.provenance === "assigned" && onRemove && <button type="button" className="output-flow-remove" aria-label={`Remove output ${item.value}`} onClick={() => onRemove(item.value)}>×</button>}
					</span>
				);
			})}
		</div>
	);
}

export interface ClassificationContributionsProps {
	classes?: ClassificationContribution[] | string[];
	outputs?: ClassificationContribution[] | string[];
	interactionStyle?: string;
	maturity?: string;
	compact?: boolean;
	onInspect?: (field: "classes" | "outputs", value: string) => void;
	onRemoveOutput?: (value: string) => void;
}

export function ClassificationContributions({ classes = [], outputs = [], interactionStyle, maturity, compact, onInspect, onRemoveOutput }: ClassificationContributionsProps) {
	return (
		<div className={`classification-contributions${compact ? " classification-contributions-compact" : ""}`}>
			{classes.length > 0 && (
				<div className="classification-values" aria-label="Classes">
					{classes.map((raw, index) => {
						const item = contribution(raw);
						return <ClassificationValue key={`${item.value}-${index}`} field="classes" value={item.value} provenance={item.provenance} onInspect={onInspect} />;
					})}
				</div>
			)}
			{!compact && <OutputFlow outputs={outputs} onInspect={onInspect} onRemove={onRemoveOutput} />}
			{!compact && (interactionStyle || maturity) && (
				<div className="classification-facts">
					{interactionStyle && <span title="Interaction style">{interactionStyle}</span>}
					{maturity && <span title="Maturity">{maturity}</span>}
				</div>
			)}
		</div>
	);
}
