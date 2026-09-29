import { parseCliJson } from "@/lib/skillPack";

export interface RepositoryAssociation {
  url: string;
  remote: string;
  subdirectory: string;
}

export interface RepositoryInspection {
  project_path: string;
  git_root: string;
  association: RepositoryAssociation;
  is_worktree: boolean;
}

export interface ProjectRepositoryError {
  code: string;
  message: string;
  field?: string | null;
}

export interface ProjectRepositoryReply {
  ok: boolean;
  project: string | null;
  repository: RepositoryAssociation | null;
  inspection: RepositoryInspection | null;
  error: ProjectRepositoryError | null;
}

function isAssociation(value: unknown): value is RepositoryAssociation {
  if (!value || typeof value !== "object") return false;
  const association = value as Record<string, unknown>;
  return typeof association.url === "string" &&
    typeof association.remote === "string" &&
    typeof association.subdirectory === "string";
}

function isInspection(value: unknown): value is RepositoryInspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Record<string, unknown>;
  return typeof inspection.project_path === "string" &&
    typeof inspection.git_root === "string" &&
    typeof inspection.is_worktree === "boolean" &&
    isAssociation(inspection.association);
}

export function parseProjectRepository(output: string): ProjectRepositoryReply {
  const raw = parseCliJson<Partial<ProjectRepositoryReply>>(output) as Record<string, unknown>;
  const error = raw.error;
  const errorValid = error === null || (
    typeof error === "object" && error !== null &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
  const repository = raw.repository;
  const inspection = raw.inspection;
  if (typeof raw.ok !== "boolean" ||
    (raw.project !== null && typeof raw.project !== "string") ||
    (repository !== null && !isAssociation(repository)) ||
    (inspection !== undefined && inspection !== null && !isInspection(inspection)) ||
    !errorValid) {
    throw new Error("The backend returned invalid project repository data.");
  }
  if (raw.ok && error !== null) {
    throw new Error("The backend returned invalid project repository data.");
  }
  if (!raw.ok && (repository !== null || (inspection !== undefined && inspection !== null))) {
    throw new Error("The backend returned invalid project repository data.");
  }
  return {
    ok: raw.ok,
    project: raw.project === undefined ? null : raw.project as string | null,
    repository: repository === undefined ? null : repository as RepositoryAssociation | null,
    inspection: inspection === undefined ? null : inspection as RepositoryInspection | null,
    error: error === undefined ? null : error as ProjectRepositoryError | null,
  };
}

export function projectRepositoryError(reply: ProjectRepositoryReply, fallback: string): Error {
  return new Error(reply.error?.message || fallback);
}
