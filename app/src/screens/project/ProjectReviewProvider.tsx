import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useUsageProject } from "@/hooks/useUsageAnalytics";
import type { UsageFinding } from "@/features/usage/usageAnalyticsTypes";

export interface ProjectReviewState {

  finding: UsageFinding | undefined;
  activeAreas: string[];
  isParticipating: (area: string) => boolean;
  highlight: string[];
}

const EMPTY_REVIEW: ProjectReviewState = {
  finding: undefined,
  activeAreas: [],
  isParticipating: () => false,
  highlight: [],
};

const ProjectReviewContext = createContext<ProjectReviewState>(EMPTY_REVIEW);

export function ProjectReviewProvider({
  projectName,
  children,
}: {
  projectName: string;
  children: ReactNode;
}) {
  const [params] = useSearchParams();
  const reviewId = params.get("review");
  const query = useUsageProject(projectName, 30);
  const finding = useMemo(
    () => query.data?.findings.find((candidate) => candidate.id === reviewId),
    [query.data?.findings, reviewId],
  );
  const activeAreas = useMemo(() => {
    if (!finding) return [];
    return [finding.review.area, ...(finding.review.also ?? [])];
  }, [finding]);
  const value = useMemo<ProjectReviewState>(
    () => ({
      finding,
      activeAreas,
      isParticipating: (area: string) => activeAreas.includes(area),
      highlight: finding?.review.highlight ?? [],
    }),
    [activeAreas, finding],
  );
  return <ProjectReviewContext.Provider value={value}>{children}</ProjectReviewContext.Provider>;
}

export function useProjectReview(): ProjectReviewState {
  return useContext(ProjectReviewContext);
}

export function ProjectReviewBoundary({ children }: { children: ReactNode }) {
  return <ProjectReviewContext.Provider value={EMPTY_REVIEW}>{children}</ProjectReviewContext.Provider>;
}
