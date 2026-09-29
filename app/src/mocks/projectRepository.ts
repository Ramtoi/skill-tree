import type {
  ProjectRepositoryReply,
  RepositoryAssociation,
  RepositoryInspection,
} from "@/lib/projectRepository";

const KEY = "st:mock:project-repository";

function readSaved(): Record<string, RepositoryAssociation> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, RepositoryAssociation>;
  } catch {
    return {};
  }
}

function writeSaved(saved: Record<string, RepositoryAssociation>) {
  localStorage.setItem(KEY, JSON.stringify(saved));
}

function inspection(project: string, remote: string): RepositoryInspection {
  return {
    project_path: `/Users/dev/projects/${project}`,
    git_root: `/Users/dev/projects/${project}`,
    association: {
      url: `https://github.com/example-org/${project}.git`,
      remote,
      subdirectory: ".",
    },
    is_worktree: false,
  };
}

export function mockProjectRepository(args: string[]): ProjectRepositoryReply {
  const verb = args[2];
  const project = args[3] ?? "example-app";
  const remoteIndex = args.indexOf("--remote");
  const remote = remoteIndex >= 0 ? args[remoteIndex + 1] ?? "origin" : "origin";
  const saved = readSaved();
  if (verb === "inspect") {
    return { ok: true, project, repository: null, inspection: inspection(project, remote), error: null };
  }
  if (verb === "set") {
    const detected = inspection(project, remote).association;
    saved[project] = detected;
    writeSaved(saved);
    return { ok: true, project, repository: detected, inspection: null, error: null };
  }
  if (verb === "clear") {
    delete saved[project];
    writeSaved(saved);
    return { ok: true, project, repository: null, inspection: null, error: null };
  }
  return { ok: true, project, repository: saved[project] ?? null, inspection: null, error: null };
}
