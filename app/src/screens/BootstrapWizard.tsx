import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";

import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { InfoBanner } from "@/components/InfoBanner";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import {
  harnessTint,
  harnessLabel,
} from "@/components/harness/harnessRegistry";
import { Icon } from "@/components/Icon";
import { BootstrapRestoreStep } from "@/components/backup/BootstrapRestoreStep";
import { BootstrapBackupStep } from "@/components/backup/BootstrapBackupStep";
import { useHarnesses } from "@/hooks/useHarnesses";
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
    ALREADY_MANAGED: { label: "MANAGED", color: "var(--anchor)" },
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
      className="im-bootstrap-wizard-1"
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

/**
 * The wizard's stage machine (design §9).
 *
 * The wizard used to be a single screen that went straight to import scanning.
 * It now opens on a decision, because "I already have a hub in a backup" and "I
 * am starting from nothing" want opposite things from the very first click —
 * and running an import scan before a restore would generate conflicts against
 * skills the restore is about to lay down anyway.
 *
 *   choose ─┬─► import ──► backup (optional, skippable) ──► done
 *           └─► restore ─────────────────────────────────► done
 *
 * `import` is the pre-existing flow, unchanged in behavior; the restore branch
 * never touches it. The one structural change to `import` is that it no longer
 * invalidates `["bootstrap"]` itself — the parent does that when a branch
 * finishes, so the optional backup step can render *after* the import applies
 * instead of being unmounted by the gate flipping.
 */
type Stage = "choose" | "import" | "backup" | "restore";

/**
 * Shared full-bleed frame for the non-import stages (the import stage keeps its
 * own scroll-body + sticky-footer layout).
 *
 * CENTRED, and capped narrower than 880px. Pinned to the top-left of a 1250px
 * viewport, these stages left everything below y≈440 as void — roughly 65% of
 * the first screen a new user ever sees, and the same "floating in a dead void"
 * complaint that was fixed on the Backup screen in round 1 recurring at the
 * front door. `place-items: center` with `min-height: 100%` centres the content
 * while still letting a tall stage (the restore plan) scroll normally, which is
 * why this is a grid rather than a flex `align-items: center` — flex centring
 * makes overflowing content unreachable at the top.
 */
function WizardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="im-bootstrap-wizard-2"
    >
      <div className="im-bootstrap-wizard-3">{children}</div>
    </div>
  );
}

function ChoiceCard({
  icon,
  title,
  body,
  cta,
  onClick,
  testId,
  primary,
}: {
  icon: string;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
  testId: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      style={{
        textAlign: "left",
        display: "grid",
        gap: 8,
        padding: 20,
        borderRadius: 10,
        border: `1px solid ${primary ? "var(--ctx)" : "var(--bg-3)"}`,
        background: "var(--bg-1)",
        cursor: "pointer",
        color: "inherit",
        font: "inherit",
      }}
    >
      <Icon name={icon} size={20} />
      <div className="im-bootstrap-wizard-4">{title}</div>
      <div className="im-bootstrap-wizard-5">{body}</div>
      {/* EQUAL WEIGHT. `Start setup →` measured 7.1:1 against `Choose a
          snapshot →`'s 4.6:1, which quietly answers an either/or the app has no
          way to answer: whether you are starting fresh or restoring is a fact
          about the user, not a recommendation. The violet border alone marks
          the default; the two calls to action read the same. */}
      <div className="im-bootstrap-wizard-6">
        {cta} →
      </div>
    </button>
  );
}

export function BootstrapWizard({ state }: Props) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>("choose");
  const setBootstrapDeferred = useAppStore((s) => s.setBootstrapDeferred);

  /** Leave the wizard: flip the gate and refresh everything it seeded. */
  const finish = () => {
    queryClient.invalidateQueries({ queryKey: qk.bootstrap() });
    void invalidateRegistry(queryClient);
  };

  if (stage === "choose") {
    return (
      <WizardFrame>
        <div data-testid="bootstrap-choose">
          <h1 className="im-bootstrap-wizard-7">
            Set up Skill Tree
          </h1>
          {/* ORIENTATION FIRST. This is the first screen anyone ever sees, and
              it used to open on a branch decision phrased in terms — library,
              skills, snapshot repo — the user had not been introduced to. One
              plain sentence about what the product does, then the fork. */}
          <p className="im-bootstrap-wizard-8">
            Skill Tree keeps your agent skills in one library and links them
            into the projects and coding agents you choose.
          </p>
          <p
            className="im-bootstrap-wizard-9"
          >
            Starting fresh, or bringing a library over from another machine?
          </p>
          <div
            className="im-bootstrap-wizard-10"
          >
            <ChoiceCard
              primary
              icon="spark"
              title="Set up fresh"
              body="Build a new library here. Skill Tree will offer to import skills it finds in ~/.claude, ~/.codex, and ~/.pi."
              cta="Start setup"
              testId="choose-fresh"
              onClick={() => setStage("import")}
            />
            <ChoiceCard
              icon="source"
              title="Restore from backup"
              body="Pull an existing library from a snapshot repo. Skips the import step — the snapshot already has everything."
              cta="Choose a snapshot"
              testId="choose-restore"
              onClick={() => setStage("restore")}
            />
          </div>
          {/* ESCAPE HATCH. The gate outranks every route, so before this the
              only way past a wizard you did not want to answer yet was to fail
              an import and take the error-path "Set up later". Quiet (ghost,
              below the fold of the two cards) — it is a deferral, not a third
              option of equal standing.

              It sets `bootstrapDeferred`, NOT `degradedMode`: nothing is
              broken here, and degraded mode would silently suppress the
              first-run tour and put the remote connector catalog offline. */}
          <div
            className="im-bootstrap-wizard-11"
          >
            <Button
              variant="ghost"
              size="sm"
              data-testid="choose-skip"
              onClick={() => setBootstrapDeferred(true)}
            >
              Set up later
            </Button>
            <span className="im-bootstrap-wizard-12">
              Look around first — the wizard returns on next launch.
            </span>
          </div>
        </div>
      </WizardFrame>
    );
  }

  if (stage === "restore") {
    return (
      <WizardFrame>
        <BootstrapRestoreStep onBack={() => setStage("choose")} onRestored={finish} />
      </WizardFrame>
    );
  }

  if (stage === "backup") {
    return (
      <WizardFrame>
        <BootstrapBackupStep onDone={finish} onSkip={finish} />
      </WizardFrame>
    );
  }

  return <ImportStep state={state} onApplied={() => setStage("backup")} />;
}

/** The pre-existing single-screen import wizard, unchanged except that it
 *  reports completion upward instead of flipping the bootstrap gate itself. */
function ImportStep({ state, onApplied }: Props & { onApplied: () => void }) {
  const queryClient = useQueryClient();
  const mutating = useAppStore((s) => s.mutating);
  const setMutating = useAppStore((s) => s.setMutating);
  const addToast = useAppStore((s) => s.addToast);
  const setDegradedMode = useAppStore((s) => s.setDegradedMode);
  const setFreshBootstrapCompleted = useAppStore(
    (s) => s.setFreshBootstrapCompleted,
  );

  // Store-backed (no extra query) harness snapshot. If not a single harness is
  // installed, imported skills won't reach any agent until one is enabled — nudge.
  const harnesses = useHarnesses();
  const noHarnessInstalled =
    harnesses.length > 0 && harnesses.every((h) => !h.installed);

  // How many skills are already in the user's registry? Used to distinguish
  // "fresh install" from "existing setup that just needs the new bootstrap marker".
  const existing = useQuery({
    queryKey: qk.registry(),
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
        // A ticked CONFLICT row shares a name with an existing skill; "add to
        // hub" means replace it. Unticked conflicts are omitted entirely (kept).
        const conflict_actions: Record<string, string> = {};
        for (const c of selectable) {
          if (c.category === "CONFLICT" && checked.has(c.path)) {
            conflict_actions[c.path] = "replace";
          }
        }
        await invoke("bootstrap_run", {
          selections: {
            register: Array.from(checked),
            conflict_actions,
            adopt: [],
            // Every row the wizard displayed. Lets the backend tell an unticked
            // row (skip) apart from a candidate that only appeared after the
            // legacy-home migration (apply the defaults), and tolerate a NEW row
            // that flipped to already-managed mid-migration.
            offered: selectable.map((c) => c.path),
          },
        });
      } finally {
        setMutating(false);
      }
    },
    onSuccess: () => {
      // Only a genuinely fresh install (zero pre-existing skills) arms the
      // first-run tips tour. A populated pre-bootstrap-version upgrade finishing
      // the wizard must NOT trigger the tour.
      if (isFreshInstall) setFreshBootstrapCompleted(true);
      addToast("success", "Skill Tree is ready");
      void invalidateRegistry(queryClient);
      // NOT `["bootstrap"]` — invalidating the gate here would unmount the
      // wizard before the optional backup step can render. The parent flips it
      // once a branch actually finishes.
      onApplied();
    },
    onError: (err: unknown) => {
      addToast("error", `Couldn't finish setup — ${err}`);
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
    ? "First-time setup. Pick which skills you already have installed to import into your library."
    : `Your existing Skill Tree library at ${state.data_home} was found (${existingSkillCount} skills). Confirm the layout below and finish the upgrade. You can also import additional skills detected in ~/.claude, ~/.codex, or ~/.pi.`;
  const actionLabel = isFreshInstall ? "Initialize Skill Tree" : "Finish upgrade";

  return (
    <div
      className="im-bootstrap-wizard-13"
    >
      <div className="im-bootstrap-wizard-14">
        <div className="im-bootstrap-wizard-15">
          <h1 className="im-bootstrap-wizard-16">{heading}</h1>
          <p className="im-bootstrap-wizard-17">{subtitle}</p>

          <div
            className="im-bootstrap-wizard-18"
          >
            <div className="im-bootstrap-wizard-19">
              Layout
            </div>
            <div className="im-bootstrap-wizard-20">
              Your data:{" "}
              <span className="im-bootstrap-wizard-21">{state.data_home}</span>
              {!isFreshInstall && (
                <span className="im-bootstrap-wizard-22">
                  ({existingSkillCount} skills preserved)
                </span>
              )}
            </div>
            <div className="im-bootstrap-wizard-23">
              App resources:{" "}
              <span className="im-bootstrap-wizard-24">{state.code_home}</span>
            </div>
            {hasLegacyMove && (
              <div
                className="im-bootstrap-wizard-25"
              >
                Legacy data directory detected at {state.legacy_detected.join(", ")} — it will be
                moved into your data home when you continue.
              </div>
            )}
          </div>

          {noHarnessInstalled && (
            <InfoBanner className="im-bootstrap-wizard-26">
              No coding agent is installed on this machine yet, so imported
              skills won't reach anything until you install one (e.g. Claude
              Code) and enable it under Harnesses.
            </InfoBanner>
          )}

          {state.blocked.length > 0 && (
            <section className="im-bootstrap-wizard-27">
              <SectionLabel>Cannot import ({state.blocked.length})</SectionLabel>
              <p className="im-bootstrap-wizard-28">
                These directories have a name that is not a valid slug. Rename their
                SKILL.md <code>name:</code> field, then re-run setup.
              </p>
              {state.blocked.map((c) => (
                <div
                  key={c.path}
                  className="im-bootstrap-wizard-29"
                >
                  · {c.path} — {c.reason}
                </div>
              ))}
            </section>
          )}

          {selectable.length > 0 ? (
            <section className="im-bootstrap-wizard-30">
              <SectionLabel>
                Importable skills ({selectable.length}) ·{" "}
                <span className="im-bootstrap-wizard-31">
                  found in ~/.claude/skills, ~/.codex/skills, ~/.pi/agent/skills
                </span>
              </SectionLabel>
              <p className="im-bootstrap-wizard-32">
                Ticked items will be added to your library. <strong>CONFLICT</strong> rows
                share a name with a skill you already have — leave them unticked to keep
                the existing version (default).
              </p>
              <div className="im-bootstrap-wizard-33">
                <Button variant="ghost" size="sm" onClick={() => toggleAll(true)}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toggleAll(false)}>
                  Select none
                </Button>
              </div>
              <div
                className="im-bootstrap-wizard-34"
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
                        className="im-bootstrap-wizard-35"
                        onChange={(e) => {
                          const next = new Set(checked);
                          if (e.target.checked) next.add(c.path);
                          else next.delete(c.path);
                          setChecked(next);
                        }}
                      />
                      <div>
                        <div className="im-bootstrap-wizard-36">
                          {c.name ?? "(unnamed)"}
                        </div>
                        <div className="im-bootstrap-wizard-37">{c.path}</div>
                        {cat === "CONFLICT" && (
                          <div className="im-bootstrap-wizard-38">
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
              className="im-bootstrap-wizard-39"
            >
              No importable skills detected from other agents. You can add skills later
              from the library.
            </p>
          )}

          {state.already_managed.length > 0 && (
            <section className="im-bootstrap-wizard-40">
              <SectionLabel>Already linked ({state.already_managed.length})</SectionLabel>
              <p className="im-bootstrap-wizard-41">
                These are already symlinked into your library from previous syncs — nothing
                to do: {state.already_managed.join(", ")}
              </p>
            </section>
          )}
        </div>
      </div>

      <div
        className="im-bootstrap-wizard-42"
      >
        {/* Same 880px column as the scroll body above, so the summary and the
            primary action line up with the content they describe. */}
        <div
          className="im-bootstrap-wizard-43"
        >
        <span className="im-bootstrap-wizard-44">
          {apply.isError ? (
            <span className="im-bootstrap-wizard-45">
              Setup didn't finish. Fix the issue and retry, or set up later —
              the wizard returns on next launch.
            </span>
          ) : (
            <>
              {checked.size > 0
                ? `${checked.size} skill${checked.size === 1 ? "" : "s"} will be imported`
                : "Nothing new will be imported"}
              {hasLegacyMove && " · legacy data directory will be migrated"}
            </>
          )}
        </span>
        {apply.isError && (
          <Button
            variant="ghost"
            disabled={mutating || apply.isPending}
            onClick={() => setDegradedMode(true)}
          >
            Set up later
          </Button>
        )}
        <Button
          variant="primary"
          disabled={mutating || apply.isPending}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? "Working…" : apply.isError ? "Retry" : actionLabel}
        </Button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="im-bootstrap-wizard-46"
    >
      {children}
    </div>
  );
}
