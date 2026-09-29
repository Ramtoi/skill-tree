import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { UsageSettings } from "./UsageSettings";
import { BackupSettings } from "./BackupSettings";
import { WorktreeSettings } from "./WorktreeSettings";
import { RemotesSettings } from "./RemotesSettings";
import { useUsagePreferences } from "@/store/usagePreferences";
import { parseEurRate } from "@/lib/usagePreferences";
import type { WorktreeDefaults } from "@/lib/worktreeDefaults";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import { StatusBadge } from "@/components/StatusBadge";
import { GlobalHarnessesPanel } from "@/components/GlobalHarnessesPanel";
import { useAgentDocsStrategy, setAgentDocsStrategy } from "@/hooks/useAgentDocs";
import { invalidateRegistry } from "@/lib/invalidate";
import { qk } from "@/lib/queryKeys";
import { type AgentDocRootStrategy } from "@/types/agentDocs";
import { useAppStore, type SettingsCategory } from "@/store";
import { useTweaks, type Tweaks } from "@/hooks/useTweaks";

const CATEGORIES: readonly { value: SettingsCategory; label: string }[] = [
  { value: "appearance", label: "Appearance" },
  { value: "agents", label: "Agents" },
  { value: "worktrees", label: "Worktrees" },
  { value: "usage", label: "Usage" },
  { value: "backup", label: "Backup" },
  { value: "remotes", label: "Remotes" },
];

function AppearanceSection() {
  const [tweaks, setTweak] = useTweaks();
  const persistenceError = useAppStore((s) => s.tweaksPersistenceError);
  const densities: Tweaks["density"][] = ["compact", "default", "cozy"];

  return (
    <section className="settings-content" aria-labelledby="settings-appearance-title">
      <div className="settings-section-heading">
        <h2 id="settings-appearance-title">Appearance</h2>
        <p>Adjust the shell around your work. Changes apply immediately.</p>
      </div>
      <div className="settings-control-list">
        <div className="settings-row settings-density-row">
          <div>
            <div className="settings-control-label">Density</div>
            <div className="settings-help">Choose the spacing used by lists and panels.</div>
          </div>
          <ChipRadios
            name="settings-density"
            label="Density"
            value={tweaks.density}
            options={densities.map((density): ChipRadioOption<Tweaks["density"]> => ({
              value: density,
              label: density,
            }))}
            onChange={(density) => setTweak("density", density)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-control-label">Show icon rail</div>
            <div className="settings-help">Keep destinations and Settings within one click.</div>
          </div>
          <Toggle
            variant="switch"
            ariaLabel="Show icon rail"
            checked={tweaks.showRail}
            onChange={(value) => setTweak("showRail", value)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-control-label">Rail labels</div>
            <div className="settings-help">Show text beside each rail icon.</div>
          </div>
          <Toggle
            variant="switch"
            ariaLabel="Rail labels"
            checked={tweaks.railExpanded}
            disabled={!tweaks.showRail}
            onChange={(value) => setTweak("railExpanded", value)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-control-label">Show navigator</div>
            <div className="settings-help">Keep the contextual project and library panel visible.</div>
          </div>
          <Toggle
            variant="switch"
            ariaLabel="Show navigator"
            checked={tweaks.showNav}
            onChange={(value) => setTweak("showNav", value)}
          />
        </div>
      </div>
      {persistenceError && (
        <div className="settings-inline-error" role="alert">
          {persistenceError}
        </div>
      )}
    </section>
  );
}

function AgentDocsSection({ active = true, onBusyChange }: { active?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const queryClient = useQueryClient();
  const strategy = useAgentDocsStrategy(undefined, active);
  const addToast = useAppStore((s) => s.addToast);
  const [pending, setPending] = useState(false);
  const [harnessPending, setHarnessPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftStrategy, setDraftStrategy] = useState<AgentDocRootStrategy>("symlink");
  const syncedGlobal = useRef<AgentDocRootStrategy | null>(null);
  useEffect(() => {
    const global = strategy.data?.global;
    if (global && syncedGlobal.current !== global) {
      syncedGlobal.current = global;
      setDraftStrategy(global);
    }
  }, [strategy.data?.global]);
  const value = draftStrategy;
  const reportHarnessPending = useCallback(
    (busy: boolean) => {
      setHarnessPending(busy);
      if (busy) onBusyChange?.(true);
    },
    [onBusyChange],
  );
  useEffect(() => onBusyChange?.(pending || harnessPending), [harnessPending, onBusyChange, pending]);

  async function changeStrategy(next: AgentDocRootStrategy) {
    setDraftStrategy(next);
    setPending(true);
    onBusyChange?.(true);
    setSaveError(null);
    try {
      await setAgentDocsStrategy({ value: next });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.agentDocs.strategyAll() }),
        queryClient.invalidateQueries({ queryKey: qk.agentDocs.rootStatusAll() }),
        queryClient.invalidateQueries({ queryKey: qk.agentDocs.all() }),
        invalidateRegistry(queryClient),
      ]);
      addToast("success", "Agent Docs linking saved — use Fix layout in a project's Agent Docs to update its files");
    } catch (err) {
      setSaveError(String(err));
      addToast("error", `Couldn't save Agent Docs linking — ${String(err)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="settings-content" aria-labelledby="settings-agents-title">
      <div className="settings-section-heading">
        <h2 id="settings-agents-title">Agents</h2>
        <p>Choose which agents are available globally and how root Agent Docs link.</p>
      </div>
      <GlobalHarnessesPanel onPendingChange={reportHarnessPending} />
      <div className="settings-section settings-agent-docs">
        <div className="settings-section-label">Agent Docs linking</div>
        <p className="settings-help">
          This changes the inherited linking policy only. It does not write files or publish them.
        </p>
        {strategy.isLoading ? (
          <div className="settings-muted">Loading the current linking policy…</div>
        ) : strategy.isError ? (
          <div className="settings-read-error" role="alert">
            <span>Couldn’t load Agent Docs linking: {String(strategy.error)}</span>
            <Button size="sm" variant="ghost" onClick={() => void strategy.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <Field
              label="Agent Docs linking"
              hint={
                pending
                  ? "Saving…"
                  : saveError
                    ? "Selection not saved. Retry to apply it."
                    : "Use Fix layout in a project's Agent Docs to update its files."
              }
            >
              <Select<AgentDocRootStrategy>
                label="Agent Docs linking"
                value={value}
                disabled={pending}
                onChange={(next) => void changeStrategy(next)}
                options={[
                  {
                    value: "symlink",
                    label: "Symlink",
                    hint: "One canonical root document; the other is a symlink.",
                  },
                  {
                    value: "import",
                    label: "Import",
                    hint: "CLAUDE.md imports AGENTS.md when both files are needed.",
                  },
                ]}
              />
            </Field>
            <div className="settings-doc-examples" aria-label="Agent Docs examples">
              <div>
                <code>AGENTS.md</code>
                <span>Example canonical document.</span>
              </div>
              <div>
                <code>CLAUDE.md</code>
                <span>{value === "symlink" ? "Symlink to AGENTS.md." : "Regular file importing AGENTS.md."}</span>
              </div>
            </div>
          </>
        )}
        {saveError && (
          <div className="settings-inline-error" role="alert">
            Couldn't save linking policy. Your selection remains available; retry when ready.
            <Button size="sm" variant="ghost" onClick={() => void changeStrategy(draftStrategy)}>
              Retry
            </Button>
          </div>
        )}
        {!strategy.isLoading && !strategy.isError && !saveError && (
          <StatusBadge channel="info" shape="pill">
            Use Fix layout in a project's Agent Docs to update its files.
          </StatusBadge>
        )}
      </div>
    </section>
  );
}

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const category = useAppStore((s) => s.settingsCategory);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const setCategory = useAppStore((s) => s.setSettingsCategory);
  const degradedMode = useAppStore((s) => s.degradedMode);
  const [pendingCategory, setPendingCategory] = useState<SettingsCategory | null>(null);
  const agentBusy = pendingCategory !== null;
  const reportAgentsPending = useCallback((busy: boolean) =>
    setPendingCategory((current) => busy ? "agents" : current === "agents" ? null : current), []);
  const reportWorktreesPending = useCallback((busy: boolean) =>
    setPendingCategory((current) => busy ? "worktrees" : current === "worktrees" ? null : current), []);
  const reportBackupPending = useCallback((busy: boolean) =>
    setPendingCategory((current) => busy ? "backup" : current === "backup" ? null : current), []);
  const reportRemotesPending = useCallback((busy: boolean) =>
    setPendingCategory((current) => busy ? "remotes" : current === "remotes" ? null : current), []);
  const [visitedCategories, setVisitedCategories] = useState<SettingsCategory[]>([]);
  useEffect(() => {
    if (open) setVisitedCategories((visited) => visited.includes(category) ? visited : [...visited, category]);
  }, [open, category]);
  // Mount categories only after they are visited, and preserve failed-write
  // choices and in-flight operations while the user reads another category.
  const visibleCategories = CATEGORIES.map((item) => item.value)
    .filter((item) => item === category || visitedCategories.includes(item));
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDefaults | null>(null);
  const [remoteDraft, setRemoteDraft] = useState<string | null>(null);
  const rate = useUsagePreferences((s) => s.eurRate);
  const rateDirty = rateDraft !== null && parseEurRate(rateDraft) !== rate;
  const [exit, setExit] = useState<{ destination?: string } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();

  function finishClose(destination?: string) {
    setRateDraft(null);
    setWorktreeDraft(null);
    setRemoteDraft(null);
    setVisitedCategories([]);
    setExit(null);
    closeSettings();
    if (destination) requestAnimationFrame(() => navigate(destination));
  }

  function requestClose(destination?: string) {
    if (agentBusy) return;
    if (rateDirty || worktreeDraft || remoteDraft !== null) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      setExit({ destination });
      // eslint-disable-next-line no-restricted-syntax -- called from a click handler: React flushes `setExit` synchronously before yielding, and the rAF always runs after that commit and before the next paint, so `[data-settings-keep]` (mounted by this same state change) is already in the DOM.
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-settings-keep]")?.focus());
    } else finishClose(destination);
  }

  function keepEditing() {
    setExit(null);
    requestAnimationFrame(() => {
      const previous = previousFocus.current;
      // eslint-disable-next-line no-restricted-syntax -- called from a click handler (same synchronous-flush-before-rAF guarantee as `requestClose` above); `previous` was captured before the exit overlay ever mounted, so it is either an unrelated already-mounted node or gone (the `else` branches below).
      if (previous?.isConnected) previous.focus();
      // eslint-disable-next-line no-restricted-syntax -- same synchronous-flush guarantee; falls back to an id lookup for a node that survived under a new instance.
      else if (previous?.id) document.getElementById(previous.id)?.focus();
      // eslint-disable-next-line no-restricted-syntax -- same synchronous-flush guarantee; `.settings-dialog` itself is always mounted while `open`.
      else document.querySelector<HTMLElement>(".settings-dialog button")?.focus();
    });
  }

  // The editor's save shortcut is a window listener. Capture it while this
  // overlay owns focus so Cmd/Ctrl+S cannot save the mounted editor underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // A retry button can disappear after a write. Restore keyboard ownership
  // when that leaves focus on the document instead of inside the dialog.
  useEffect(() => {
    if (!open || agentBusy) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); the active category nav item is already mounted whenever the dialog is `open`.
      document.querySelector<HTMLElement>('.settings-dialog [aria-current="page"]')?.focus();
      if (document.activeElement === document.body) {
        // eslint-disable-next-line no-restricted-syntax -- same already-mounted rAF as above; `.settings-dialog` itself is always mounted while `open`.
        document.querySelector<HTMLElement>(".settings-dialog")?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, agentBusy]);

  // The opener can be the rail button whose own preference was changed inside
  // this dialog. When that button disappears, return focus to the surviving
  // shell fallback instead of leaving WebKit on a detached node.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    requestAnimationFrame(() => {
      const fallback = document.querySelector<HTMLElement>('.settings-toggle:not([data-hidden="true"])');
      // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); `fallback` is the shell's own rail button, unaffected by this dialog's own close.
      if (fallback && !document.querySelector(".modal-backdrop")) fallback.focus();
    });
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={() => exit ? keepEditing() : requestClose()}
      dismissable={!agentBusy}
      title="Settings"
      width={800}
      className="settings-dialog"
      aria-label="Settings"
    >
      {exit && <div className="settings-content">
        <h2>Discard unsaved settings?</h2>
        <p>Your unsaved settings will be discarded. Preferences already saved stay applied.</p>
        <div className="settings-actions">
          <Button data-settings-keep="true" onClick={keepEditing}>Keep editing</Button>
          <Button variant="ghost" onClick={() => finishClose(exit.destination)}>Discard changes</Button>
        </div>
      </div>}
      <div className="settings-layout" hidden={!!exit}>
        <nav className="settings-categories" aria-label="Settings categories">
          <div className="settings-category-select-label">
            <span>Settings category</span>
            <Select<SettingsCategory>
              value={category}
              label="Settings category"
              menuPortal
              menuClassName="settings-category-menu"
              onChange={setCategory}
              options={CATEGORIES.map((item) => ({ ...item, label: item.label +
                ((item.value === "usage" && rateDirty || item.value === "worktrees" && worktreeDraft || item.value === "remotes" && remoteDraft !== null) ? " • unsaved" : "") }))}
            />
          </div>
          <div className="settings-category-buttons">
            {CATEGORIES.map((item) => (
              <button
                key={item.value}
                type="button"
                  aria-current={category === item.value ? "page" : undefined}
                onClick={() => setCategory(item.value)}
              >
                {item.label}{(item.value === "usage" && rateDirty || item.value === "worktrees" && worktreeDraft || item.value === "remotes" && remoteDraft !== null) && <span aria-label="unsaved changes"> •</span>}
              </button>
            ))}
          </div>
        </nav>
        {visibleCategories.map((item) => (
          <fieldset key={item} className="settings-category-panel" hidden={category !== item}
            disabled={agentBusy && pendingCategory !== item}>
            {pendingCategory && pendingCategory !== item && (
              <p className="settings-pending settings-help" role="status">
                Saving {CATEGORIES.find((option) => option.value === pendingCategory)?.label} settings…
                Other settings are read-only until the save finishes.
              </p>
            )}
        {item === "appearance" ? <AppearanceSection /> : item === "usage" ? (
          <UsageSettings draft={rateDraft} onDraftChange={setRateDraft} />
        ) : degradedMode ? (
          <section className="settings-content" aria-labelledby={`settings-${item}-unavailable`}>
            <div className="settings-section-heading">
              <h2 id={`settings-${item}-unavailable`}>{CATEGORIES.find((option) => option.value === item)?.label}</h2>
              <p>Configuration is unavailable while the backend is in degraded mode.</p>
            </div>
            <StatusBadge channel="error" shape="pill">Backend unavailable</StatusBadge>
          </section>
        ) : item === "worktrees" ? (
          <WorktreeSettings active={item === category} draft={worktreeDraft} onDraftChange={setWorktreeDraft}
            onPendingChange={reportWorktreesPending} onNavigate={requestClose} />
        ) : item === "backup" ? (
          <BackupSettings active={item === category} onPendingChange={reportBackupPending} onNavigate={requestClose} />
        ) : item === "remotes" ? (
          <RemotesSettings active={item === category} draft={remoteDraft} onDraftChange={setRemoteDraft}
            onPendingChange={reportRemotesPending} onNavigate={requestClose} />
        ) : <AgentDocsSection active={item === category} onBusyChange={reportAgentsPending} />}
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}
