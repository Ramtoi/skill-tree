import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { HarnessGlyph } from "./harness/HarnessGlyph";
import {
  harnessTint,
  harnessLabel,
} from "./harness/harnessRegistry";
import type { Scope } from "@/types/permissions";

interface RecentImport {
  harness_id: string;
  timestamp: string;
  backup_path: string;
  source_file: string;
}

export interface ImportedBannerProps {
  /** Project name (drives the localStorage dismissal key). */
  projectName: string;
  /** Number of rules currently in the project's permissions block (best-effort
   *  count used in the banner copy). */
  ruleCount: number;
}

const HARNESS_SOURCE_FILE: Record<string, string> = {
  "claude-code": ".claude/settings.json",
  pi: ".pi/agent/settings.json",
  codex: ".codex/config.toml",
};

function dismissalKey(project: string, harness: string, timestamp: string) {
  return `permissions-banner:${project}:${harness}:${timestamp}`;
}

/** Inline banner shown on the project Permissions tab when a recent
 *  auto-import has populated `projects.<name>.permissions`. The banner's
 *  dismissal is keyed on `(project_name, harness_id, last_import_timestamp)`
 *  — a new import always produces a new timestamp and re-shows the banner
 *  even if the previous one was dismissed. */
export function ImportedBanner({ projectName, ruleCount }: ImportedBannerProps) {
  const [imports, setImports] = useState<RecentImport[] | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const scope: Scope = { kind: "project", name: projectName };
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<RecentImport[]>(
          "permissions_recent_imports",
          { scope },
        );
        if (!cancelled) setImports(result);
      } catch {
        if (!cancelled) setImports([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  if (!imports || imports.length === 0) return null;
  // Show the most recent import (sorted lex by timestamp). One banner per
  // harness when multiple are present.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {imports.map((imp) => {
        const key = dismissalKey(projectName, imp.harness_id, imp.timestamp);
        if (dismissed[key]) return null;
        const persisted =
          typeof window !== "undefined" &&
          window.localStorage.getItem(key) === "1";
        if (persisted) return null;
        const sourceFile =
          imp.source_file || HARNESS_SOURCE_FILE[imp.harness_id] || imp.harness_id;
        const label = harnessLabel(imp.harness_id);
        return (
          <div
            key={key}
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: "var(--radius)",
              border: "1px solid color-mix(in oklab, var(--violet) 40%, transparent)",
              background: "color-mix(in oklab, var(--violet) 8%, transparent)",
              color: "var(--fg-strong)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              ["--harness-accent" as string]: harnessTint(imp.harness_id),
            }}
          >
            <Icon name="check" size={13} tone="violet" />
            <span>
              Imported {ruleCount} rule{ruleCount === 1 ? "" : "s"} from{" "}
              <span
                className="inline-harness-source"
                title={`${label} native permissions`}
              >
                <HarnessGlyph
                  id={imp.harness_id}
                  label={label}
                  size={14}
                  decorative
                />
                {sourceFile}
              </span>
            </span>
            <span style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // Open the backup file in the OS file manager
                void invoke("pick_directory", { initial: imp.backup_path });
              }}
              title={imp.backup_path}
            >
              view backup
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="x"
              title="Dismiss"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.localStorage.setItem(key, "1");
                }
                setDismissed((cur) => ({ ...cur, [key]: true }));
              }}
            >
              <span className="sr-only">Dismiss</span>
            </Button>
          </div>
        );
      })}
    </div>
  );
}
