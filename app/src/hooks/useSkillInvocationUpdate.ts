import { useCallback, useEffect, useRef, useState } from "react";
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { errorHeadline } from "@/lib/cliOutput";
import { invalidateRegistry } from "@/lib/invalidate";
import { parseAutoSyncTail } from "@/lib/hubWrite";
import {
	effectiveLibraryMode,
	INVOCATION_LABEL,
	type InvocationMode,
	type InvocationSettled,
} from "@/lib/invocation";
import type { QueryClient } from "@tanstack/react-query";

interface InvocationUiState {
	skillName: string | undefined;
	requestId: number;
	mode: InvocationMode | "conflicted";
	busy: false | InvocationMode;
	settled: InvocationSettled;
}

export function useSkillInvocationUpdate(
	skillName: string | undefined,
	invocation: string | undefined,
	queryClient: QueryClient,
	toast: {
		push: (input: {
			kind?: "info" | "success" | "error";
			title: string;
			body?: string;
			duration?: number;
		}) => void;
	},
) {
	const registryMode: InvocationMode | "conflicted" =
		invocation === "conflicted" ? "conflicted" : effectiveLibraryMode(invocation);
	const epochRef = useRef(0);
	const [state, setState] = useState<InvocationUiState>({
		skillName,
		requestId: 0,
		mode: registryMode,
		busy: false,
		settled: null,
	});

	useEffect(() => {
		if (state.skillName !== skillName) {
			const requestId = ++epochRef.current;
			setState({
				skillName,
				requestId,
				mode: registryMode,
				busy: false,
				settled: null,
			});
		} else if (!state.busy && state.mode !== registryMode) {
			setState((prev) => ({ ...prev, mode: registryMode }));
		}
	}, [registryMode, skillName, state.busy, state.mode, state.skillName]);

	useEffect(() => {
		if (!state.settled) return;
		const timer = window.setTimeout(() => {
			setState((prev) =>
				prev.skillName === skillName && prev.settled === state.settled
					? { ...prev, settled: null }
					: prev,
			);
		}, 2400);
		return () => window.clearTimeout(timer);
	}, [skillName, state.settled]);

	const update = useCallback(
		async (mode: InvocationMode) => {
			if (!skillName || (state.skillName === skillName && state.busy)) return;
			const requestName = skillName;
			const requestId = ++epochRef.current;
			setState({
				skillName: requestName,
				requestId,
				mode,
				busy: mode,
				settled: null,
			});
			try {
				const result = await hubCmd([
					"set-meta",
					skillName,
					"--invocation",
					mode,
				]);
				if (!result.success) {
					throw new Error(
						errorHeadline(hubStreams(result), "Couldn't change triggering"),
					);
				}
				const feedback = parseAutoSyncTail(hubStreams(result));
				await invalidateRegistry(queryClient);
				setState((prev) =>
					prev.skillName === requestName && prev.requestId === requestId
						? {
								...prev,
								settled: feedback.partial ? "saved" : "synced",
								busy: false,
						  }
						: prev,
				);
				const title = `Changed triggering to ${INVOCATION_LABEL[mode]}`;
				const syncHeadline = (
					feedback.headline ?? "Sync did not finish"
				).replace(/[.!?]+$/, "");
				toast.push(
					feedback.partial
						? {
								kind: "info",
								title,
								body: `${syncHeadline}. Run hub sync to retry.`,
								duration: 6000,
							}
						: { kind: "success", title },
				);
			} catch (err) {
				setState((prev) =>
					prev.skillName === requestName && prev.requestId === requestId
						? { ...prev, mode: registryMode, busy: false }
						: prev,
				);
				toast.push({
					kind: "error",
					title: "Couldn't change triggering",
					body: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setState((prev) =>
					prev.skillName === requestName && prev.requestId === requestId
						? { ...prev, busy: false }
						: prev,
				);
			}
		},
		[skillName, queryClient, registryMode, state, toast],
	);

	return {
		optimisticMode: state.skillName === skillName ? state.mode : registryMode,
		invocationBusy: state.skillName === skillName ? state.busy : false,
		invocationSettled: state.skillName === skillName ? state.settled : null,
		update,
	};
}
