import { useCallback, useEffect, useMemo, useState } from "react";
import { type NavigateFunction } from "react-router-dom";
import { openSidePanelSection } from "@/components/SidePanelSection";
import { useSkillClassificationUpdate, useSkillRefsGraph } from "@/hooks/useSkillClassification";
import { asciiIdentity, compareClassContributions, nextSimpleContributionPaths, resolveClassificationContributions, type SimplePathCursor } from "@/lib/skillClassification";
import type { Registry } from "@/types";
import { fromNav, skillBackTarget, type BackTarget } from "@/lib/backTarget";

export function useSkillClassificationEditor(routeName: string | undefined, registry: Registry | undefined, back: BackTarget, navigate: NavigateFunction) {
	const classificationUpdate = useSkillClassificationUpdate(routeName ?? "");
	const refsGraph = useSkillRefsGraph();
	const [classificationSelection, setClassificationSelection] = useState<{ field: "classes" | "outputs"; value: string } | null>(null);
	const [classificationPaths, setClassificationPaths] = useState<string[][]>([]);
	const [classificationCursor, setClassificationCursor] = useState<SimplePathCursor | null>(null);
	const [classificationContributorIndex, setClassificationContributorIndex] = useState(0);
	useEffect(() => {
		setClassificationSelection(null);
		setClassificationPaths([]);
		setClassificationCursor(null);
		setClassificationContributorIndex(0);
	}, [routeName, registry, refsGraph.data]);
	const classificationContributions = useMemo(() => {
		if (!routeName || !registry) return { classes: [], outputs: [] };
		if (!refsGraph.data) {
			const assigned = registry.skills[routeName]?.classification;
			return {
				classes: (assigned?.classes ?? []).map((value) => ({ value, provenance: "assigned" as const, contributors: [routeName] })).sort(compareClassContributions),
				outputs: (assigned?.outputs ?? []).map((value) => ({ value, provenance: "assigned" as const, contributors: [routeName] })),
			};
		}
		return resolveClassificationContributions(routeName, registry, refsGraph.data);
	}, [routeName, registry, refsGraph.data]);
	// Configuration separates references from assignments. Exclude only this
	// skill's assignments, so overlapping values retain their reference paths.
	const referenceContributions = useMemo(() => {
		if (!routeName || !registry || !refsGraph.data) return { classes: [], outputs: [] };
		const skill = registry.skills[routeName];
		if (!skill) return { classes: [], outputs: [] };
		const referencesRegistry = { ...registry, skills: { ...registry.skills, [routeName]: { ...skill, classification: undefined } } };
		return resolveClassificationContributions(routeName, referencesRegistry, refsGraph.data);
	}, [routeName, registry, refsGraph.data]);
	const classificationSuggestions = useMemo(() => {
		if (!registry) return { classes: [], outputs: [] };
		const classes = new Set<string>();
		const outputs = new Set<string>();
		for (const entry of Object.values(registry.skills)) {
			for (const value of entry.classification?.classes ?? []) classes.add(value);
			for (const value of entry.classification?.outputs ?? []) outputs.add(value);
		}
		return { classes: [...classes].sort(), outputs: [...outputs].sort() };
	}, [registry]);
	const selectedContribution = useMemo(() => {
		if (!classificationSelection) return null;
		return referenceContributions[classificationSelection.field].find((item) => asciiIdentity(item.value) === asciiIdentity(classificationSelection.value))
			?? classificationContributions[classificationSelection.field].find((item) => asciiIdentity(item.value) === asciiIdentity(classificationSelection.value)) ?? null;
	}, [classificationContributions, referenceContributions, classificationSelection]);
	const inspectClassification = useCallback((field: "classes" | "outputs", value: string) => {
		openSidePanelSection("runtime");
		setClassificationSelection({ field, value });
		setClassificationPaths([]);
		setClassificationCursor(null);
		setClassificationContributorIndex(0);
	}, []);
	const clearClassificationSelection = useCallback(() => setClassificationSelection(null), []);
	const openClassificationContributor = useCallback((name: string) => {
		if (!routeName) return;
		navigate(`/skill/${encodeURIComponent(name)}`, fromNav({ ...skillBackTarget(routeName), restore: { from: back } }));
	}, [back, navigate, routeName]);
	const loadMoreClassificationPaths = useCallback(() => {
		if (!classificationSelection || !selectedContribution || !refsGraph.data || selectedContribution.contributors.length === 0) return;
		const index = classificationContributorIndex;
		if (index >= selectedContribution.contributors.length) return;
		const contributor = selectedContribution.contributors[index];
		const result = nextSimpleContributionPaths(routeName ?? "", contributor, refsGraph.data, classificationCursor, 8, registry ? new Set(Object.keys(registry.skills)) : undefined);
		setClassificationPaths((previous) => [...previous, ...result.paths]);
		if (result.nextCursor) setClassificationCursor(result.nextCursor);
		else { setClassificationCursor(null); setClassificationContributorIndex(index + 1); }
	}, [classificationSelection, selectedContribution, refsGraph.data, classificationCursor, classificationContributorIndex, routeName, registry]);
	useEffect(() => {
		if (classificationSelection && selectedContribution && classificationPaths.length === 0 && classificationCursor === null && classificationContributorIndex === 0) loadMoreClassificationPaths();
	}, [classificationSelection, selectedContribution, classificationPaths.length, classificationCursor, classificationContributorIndex, loadMoreClassificationPaths]);
	const classificationPanelProps = {
		classification: classificationUpdate,
		classificationClasses: referenceContributions.classes,
		classificationOutputs: referenceContributions.outputs,
		graphPending: refsGraph.isPending && !refsGraph.data,
		graphError: refsGraph.error ?? undefined,
		graphCached: !!refsGraph.data,
		onRetryGraph: () => void refsGraph.refetch(),
		onInspectClassification: inspectClassification,
		inspection: classificationSelection && selectedContribution ? {
			field: classificationSelection.field,
			value: classificationSelection.value,
			contributors: selectedContribution.contributors,
			paths: classificationPaths,
			hasMore: classificationContributorIndex < selectedContribution.contributors.length,
		} : null,
		onCloseInspection: clearClassificationSelection,
		onOpenContributor: openClassificationContributor,
		onLoadMorePaths: loadMoreClassificationPaths,
		classSuggestions: classificationSuggestions.classes,
		outputSuggestions: classificationSuggestions.outputs,
	};
	return {
		classificationUpdate,
		refsGraph,
		classificationContributions,
		classificationSuggestions,
		classificationSelection,
		classificationPaths,
		classificationContributorIndex,
		selectedContribution,
		inspectClassification,
		clearClassificationSelection,
		openClassificationContributor,
		classificationPanelProps,
		loadMoreClassificationPaths,
	};
}
