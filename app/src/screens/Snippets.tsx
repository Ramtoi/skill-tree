import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useSnippetNames } from "@/hooks/useSnippets";
import { useAppStore } from "@/store";

/**
 * `/snippets` — the landing route. It never renders a library of its own: the
 * NavPanel's Context group already enumerates every snippet, so this screen's
 * only job is to redirect into `/snippet/:name` (the most recently visited
 * one, or else the first alphabetically) — or, with nothing in the library
 * yet, offer the one CTA that creates the first one.
 */
export function Snippets() {
	const navigate = useNavigate();
	// Names-only — the redirect + empty-state check never needs the
	// scan-derived usage roll-up (that's what made this route take ~10s).
	const { data: lib = [], isPending } = useSnippetNames();
	const recentlyVisited = useAppStore((s) => s.recentlyVisited);

	/* AN UNREAD LIBRARY IS NOT AN EMPTY ONE. `lib` defaults to `[]` while the
	   first `snippets_list` is still in flight, so a first visit — with a
	   populated library — must not flash "No snippets yet" before redirecting.
	   Same gate the Library screen uses (SkillLibrary's `isLoading` branch). */
	if (isPending) {
		return (
			<>
				{/* C4: the chrome is not part of the payload. */}
				<ScreenHeader
					icon="snippet"
					title="Snippets"
					crumbs={["skill-tree", "snippets"]}
				/>
				<div className="main-body">
					<EmptyState
						icon="snippet"
						title="Loading snippets"
						description="Reading your library…"
					/>
				</div>
			</>
		);
	}

	if (lib.length === 0) {
		return (
			<>
				<ScreenHeader
					icon="snippet"
					title="Snippets"
					crumbs={["skill-tree", "snippets"]}
				/>
				<div className="main-body">
					<EmptyState
						icon="snippet"
						title="No snippets yet"
						description="A snippet is a reusable instruction block you compose into agent doc files — house rules, a validation checklist, a review procedure. Write it once here and apply it to any project."
						action={
							<Button
								variant="primary"
								icon="plus"
								onClick={() => navigate("/snippet/new")}
							>
								New snippet
							</Button>
						}
					/>
				</div>
			</>
		);
	}

	// The most recently visited snippet that is still in the library, else the
	// first one alphabetically — the same order the NavPanel's Snippets rows
	// render in. `recentlyVisited` is stored newest-first (see store.ts), so
	// `find` alone picks the most recent match.
	const names = new Set(lib.map((s) => s.name));
	const recent = recentlyVisited.find(
		(r) => r.type === "snippet" && names.has(r.name),
	);
	const target =
		recent?.name ??
		[...lib].map((s) => s.name).sort((a, b) => a.localeCompare(b))[0];

	return <Navigate replace to={`/snippet/${encodeURIComponent(target)}`} />;
}
