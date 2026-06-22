import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import {
  harnessTint,
  harnessLabel,
} from "@/components/harness/harnessRegistry";
import { useAppStore } from "@/store";

type Category =
  | "NEW"
  | "BROKEN"
  | "CONFLICT"
  | "ALREADY_MANAGED"
  | "INVALID_NAME"
  | "SILENT_SKIP";

interface Candidate {
  origin: string;
  path: string;
  name: string | null;
  version?: string;
  description?: string;
  category?: Category;
  broken?: boolean;
  candidate_sha?: string;
  existing_sha?: string;
  existing_source?: string;
  reason?: string;
}

export interface BootstrapState {
  needs_bootstrap: boolean;
  completed_at: string | null;
  version: number;
  legacy_detected: string[];
  data_home: string;
  code_home: string;
  candidates: Candidate[];
  conflicts: Candidate[];
  blocked: Candidate[];
  already_managed: string[];
  silent_skip: string[];
}

interface Props {
  state: BootstrapState;
}

function CategoryBadge({ category }: { category: Category }) {
  const map: Record<Category, { label: string; color: string }> = {
    NEW: { label: "NEW", color: "var(--green)" },
    BROKEN: { label: "BROKEN", color: "var(--amber)" },
    CONFLICT: { label: "CONFLICT", color: "var(--amber)" },
    ALREADY_MANAGED: { label: "MANAGED", color: "var(--violet)" },
    INVALID_NAME: { label: "INVALID NAME", color: "var(--red)" },
    SILENT_SKIP: { label: "DUPLICATE", color: "var(--fg-dim)" },
  };
  const meta = map[category];
  return (
    <Tag color={meta.color} kind="outline">
      {meta.label}
    </Tag>
  );
}

function harnessIdForOrigin(origin: string): string | null {
  if (origin === "claude" || origin === "claude-code") return "claude-code";
  if (origin === "codex" || origin === "legacy-codex") return "codex";
  if (origin === "pi") return "pi";
  return null;
}

function OriginTag({ origin }: { origin: string }) {
  const harnessId = harnessIdForOrigin(origin);
  if (!harnessId) return <Tag>{origin}</Tag>;
  return (
    <Tag
      color={harnessTint(harnessId)}
      kind={origin === "legacy-codex" ? "outline" : "soft"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "var(--font-mono)",
      }}
    >
      <HarnessGlyph
        id={harnessId}
        label={harnessLabel(harnessId)}
        size={14}
        decorative
      />
      {origin}
    </Tag>
  );
}

export function BootstrapWizard({ state }: Props) {
  const queryClient = useQueryClient();
  const mutating = useAppStore((s) => s.mutating);
  const setMutating = useAppStore((s) => s.setMutating);
  const addToast = useAppStore((s) => s.addToast);

  // How many skills are already in the user's registry? Used to distinguish
  // "fresh install" from "existing setup that just needs the new bootstrap marker".
  const existing = useQuery({
    queryKey: ["registry"],
    queryFn: () =>
      invoke<{ skills?: Record<string, unknown> }>("read_registry").catch(
        () => ({ skills: {} } as { skills?: Record<string, unknown> })
      ),
    staleTime: 60_000,
  });
  const existingSkillCount = Object.keys(existing.data?.skills ?? {}).length;
  const isFreshInstall = existingSkillCount === 0;
  const hasLegacyMove = state.legacy_detected.length > 0;

  const selectable = useMemo(
    () =>
      [...state.candidates, ...state.conflicts].filter(
        (c) => c.category === "NEW" || c.category === "CONFLICT" || c.category === "BROKEN"
      ),
    [state]
  );

  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(selectable.filter((c) => c.category === "NEW").map((c) => c.path))
  );

  const apply = useMutation({
    mutationFn: async () => {
      setMutating(true);
      try {
        await invoke("bootstrap_run", {
          selections: {
            register: Array.from(checked),
            conflict_actions: {},
            adopt: [],
          },
        });
      } finally {
        setMutating(false);
      }
    },
    onSuccess: () => {
      addToast("success", "Skill hub ready");
      queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
      queryClient.invalidateQueries({ queryKey: ["registry"] });
    },
    onError: (err: unknown) => {
      addToast("error", `Setup failed: ${err}`);
    },
  });

  const toggleAll = (on: boolean) => {
    if (on) {
      setChecked(new Set(selectable.map((c) => c.path)));
    } else {
      setChecked(new Set());
    }
  };

  const heading = isFreshInstall ? "Set up Skill Tree" : "Finish upgrading Skill Tree";
  const subtitle = isFreshInstall
    ? "First-time setup. Pick which skills you already have installed to import into the hub."
    : `Your existing skill hub at ${state.data_home} was found (${existingSkillCount} skills). Confirm the layout below and finish the upgrade. You can also import additional skills detected in ~/.claude, ~/.codex, or ~/.pi.`;
  const actionLabel = isFreshInstall ? "Initialize Skill Hub" : "Finish upgrade";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-0)",
      }}
    >
      <div style={{ flex: 1, overflow: "auto", padding: "32px 48px 24px" }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <h1 style={{ fontSize: 22, margin: 0, color: "var(--fg-strong)" }}>{heading}</h1>
          <p style={{ marginTop: 8, color: "var(--fg-mid)", lineHeight: 1.5 }}>{subtitle}</p>

          <div
            style={{
              marginTop: 24,
              padding: 16,
              border: "1px solid var(--bg-3)",
              borderRadius: 8,
              background: "var(--bg-1)",
              display: "grid",
              gap: 6,
            }}
          >
            <div style={{ fontSize: 11, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Layout
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-mid)" }}>
              Your data:{" "}
              <span style={{ color: "var(--fg-strong)" }}>{state.data_home}</span>
              {!isFreshInstall && (
                <span style={{ color: "var(--green)", marginLeft: 8 }}>
                  ({existingSkillCount} skills preserved)
                </span>
              )}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-mid)" }}>
              App resources:{" "}
              <span style={{ color: "var(--fg-strong)" }}>{state.code_home}</span>
            </div>
            {hasLegacyMove && (
              <div
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: "var(--bg-2)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--amber)",
                }}
              >
                Legacy hub detected at {state.legacy_detected.join(", ")} — it will be
                moved into your data home when you continue.
              </div>
            )}
          </div>

          {state.blocked.length > 0 && (
            <section style={{ marginTop: 28 }}>
              <SectionLabel>Cannot import ({state.blocked.length})</SectionLabel>
              <p style={{ fontSize: 12, color: "var(--fg-mute)", margin: "4px 0 8px" }}>
                These directories have a name that is not a valid slug. Rename their
                SKILL.md <code>name:</code> field, then re-run setup.
              </p>
              {state.blocked.map((c) => (
                <div
                  key={c.path}
                  style={{
                    padding: "6px 10px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--red)",
                  }}
                >
                  · {c.path} — {c.reason}
                </div>
              ))}
            </section>
          )}

          {selectable.length > 0 ? (
            <section style={{ marginTop: 28 }}>
              <SectionLabel>
                Importable skills ({selectable.length}) ·{" "}
                <span style={{ color: "var(--fg-mute)", textTransform: "none" }}>
                  found in ~/.claude/skills, ~/.codex/skills, ~/.pi/agent/skills
                </span>
              </SectionLabel>
              <p style={{ fontSize: 12, color: "var(--fg-mute)", margin: "4px 0 8px" }}>
                Ticked items will be added to your hub. <strong>CONFLICT</strong> rows
                share a name with a skill you already have — leave them unticked to keep
                the existing version (default).
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <Button variant="ghost" size="sm" onClick={() => toggleAll(true)}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toggleAll(false)}>
                  Select none
                </Button>
              </div>
              <div
                style={{
                  border: "1px solid var(--bg-3)",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {selectable.map((c) => {
                  const cat = (c.category as Category) || "NEW";
                  const disabled = (cat as string) === "INVALID_NAME";
                  const isChecked = checked.has(c.path);
                  return (
                    <label
                      key={c.path}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto auto",
                        alignItems: "start",
                        gap: 12,
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--bg-2)",
                        opacity: disabled ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={disabled}
                        style={{ marginTop: 3 }}
                        onChange={(e) => {
                          const next = new Set(checked);
                          if (e.target.checked) next.add(c.path);
                          else next.delete(c.path);
                          setChecked(next);
                        }}
                      />
                      <div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
                          {c.name ?? "(unnamed)"}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--fg-mute)" }}>{c.path}</div>
                        {cat === "CONFLICT" && (
                          <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 4 }}>
                            Differs from existing skill at {c.existing_source} (SHAs{" "}
                            {c.candidate_sha} vs {c.existing_sha})
                          </div>
                        )}
                      </div>
                      <OriginTag origin={c.origin} />
                      <CategoryBadge category={cat} />
                    </label>
                  );
                })}
              </div>
            </section>
          ) : (
            <p
              style={{
                marginTop: 28,
                padding: 12,
                color: "var(--fg-mute)",
                fontSize: 13,
                background: "var(--bg-1)",
                borderRadius: 8,
              }}
            >
              No importable skills detected from other agents. You can add skills later
              from the library.
            </p>
          )}

          {state.already_managed.length > 0 && (
            <section style={{ marginTop: 28 }}>
              <SectionLabel>Already linked ({state.already_managed.length})</SectionLabel>
              <p style={{ fontSize: 12, color: "var(--fg-mute)", margin: "4px 0 0" }}>
                These are already symlinked into your hub from previous syncs — nothing
                to do: {state.already_managed.join(", ")}
              </p>
            </section>
          )}
        </div>
      </div>

      <div
        style={{
          padding: "12px 48px",
          borderTop: "1px solid var(--bg-3)",
          background: "var(--bg-1)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--fg-mute)", marginRight: "auto" }}>
          {checked.size > 0
            ? `${checked.size} skill${checked.size === 1 ? "" : "s"} will be imported`
            : "Nothing new will be imported"}
          {hasLegacyMove && " · legacy hub will be migrated"}
        </span>
        <Button
          variant="primary"
          disabled={mutating || apply.isPending}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? "Working…" : actionLabel}
        </Button>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--fg-mute)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </div>
  );
}
