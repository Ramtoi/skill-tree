import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type CSSProperties,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { useRegistry } from "@/hooks/useRegistry";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { Tag } from "@/components/Tag";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Field } from "@/components/Field";
import { SearchInput } from "@/components/SearchInput";
import { SkillCard } from "@/components/SkillCard";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/Modal";
import { bundleColor } from "@/components/bundleColors";
import { ResizableSplit } from "@/components/ResizableSplit";
import {
  getBundleScope,
  viaBundles,
} from "@/lib/resolveActiveSkills";
import type { SkillScope } from "@/types";

const SCOPE_LABEL: Record<SkillScope, string> = {
  global: "GLOBAL",
  portable: "PORTABLE",
  "project-specific": "PROJECT",
};

const SCOPE_ORDER: SkillScope[] = ["global", "portable", "project-specific"];

const numberBadgeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--fg-dim)",
  background: "var(--bg-3)",
  padding: "1px 5px",
  borderRadius: 3,
  minWidth: 22,
  textAlign: "center",
};

export function BundleManager() {
  const { name: routeName } = useParams<{ name: string }>();
  const bundleName = routeName ?? "";
  const navigate = useNavigate();
  const toast = useToast();
  const { data: registry } = useRegistry();
  const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);

  const bundle = bundleName ? registry?.bundles[bundleName] : undefined;

  const [desc, setDesc] = useState("");
  const [icon, setIcon] = useState("📦");
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  // Hydrate from registry when the bundle loads / changes (and we have no
  // unsaved local edits to clobber).
  useEffect(() => {
    if (bundle && !dirty) {
      setDesc(bundle.description ?? "");
      setIcon(bundle.icon ?? "📦");
      setPicked(bundle.skills ?? []);
    }
  }, [bundle, dirty]);

  useEffect(() => {
    if (bundleName) addRecentlyVisited({ type: "bundle", name: bundleName });
  }, [bundleName, addRecentlyVisited]);

  const appliedProjects = useMemo(() => {
    if (!registry) return [];
    return Object.entries(registry.projects)
      .filter(([, p]) => p.bundles?.includes(bundleName))
      .map(([n]) => n);
  }, [registry, bundleName]);

  // Blast radius: which (project, skill) activations deactivate if this bundle
  // is deleted. A skill survives if it's directly enabled, provided by another
  // applied bundle (viaBundles), or by a globally-scoped bundle.
  const deactivations = useMemo(() => {
    if (!registry) return [] as Array<{ project: string; skill: string }>;
    const bundleSkills = registry.bundles[bundleName]?.skills ?? [];
    const globallyProvided = new Set<string>();
    for (const b of Object.values(registry.bundles)) {
      if (getBundleScope(b) === "global") {
        (b.skills ?? []).forEach((s) => globallyProvided.add(s));
      }
    }
    const out: Array<{ project: string; skill: string }> = [];
    for (const p of appliedProjects) {
      const proj = registry.projects[p];
      for (const s of bundleSkills) {
        const direct = proj.enabled?.includes(s);
        const otherBundle = viaBundles(s, proj, registry).some(
          (bn) => bn !== bundleName,
        );
        if (!direct && !otherBundle && !globallyProvided.has(s)) {
          out.push({ project: p, skill: s });
        }
      }
    }
    return out;
  }, [registry, bundleName, appliedProjects]);

  const deactivatingSkills = useMemo(
    () => new Set(deactivations.map((d) => d.skill)),
    [deactivations],
  );

  const allSkills = registry?.skills ?? {};

  const filteredAllSkills = useMemo(() => {
    const lq = q.trim().toLowerCase();
    return Object.entries(allSkills)
      .filter(([name, s]) => {
        if (!lq) return true;
        return (
          name.toLowerCase().includes(lq) ||
          (s.description ?? "").toLowerCase().includes(lq)
        );
      })
      .map(([name, s]) => ({ name, ...s }));
  }, [allSkills, q]);

  if (!bundle) {
    return (
      <div className="page-scroll">
        <div className="page-frame">
          <EmptyState
            icon="bundle"
            title={`Bundle "${bundleName}" not found`}
            description="Pick another bundle from the library."
            action={
              <Button
                variant="ghost"
                icon="arrow-left"
                onClick={() => navigate("/")}
              >
                Back to library
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const color = bundleColor(bundleName);

  function toggle(name: string) {
    setPicked((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name],
    );
    setDirty(true);
  }

  function removeSkill(name: string) {
    setPicked((prev) => prev.filter((s) => s !== name));
    setDirty(true);
  }

  function moveSkill(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    setPicked((prev) => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setDirty(true);
  }

  function handleCardDragStart(
    e: DragEvent<HTMLDivElement>,
    name: string,
    idx: number,
  ) {
    e.dataTransfer.setData("text/bundle-skill", name);
    e.dataTransfer.setData("text/skill-idx", String(idx));
    e.dataTransfer.effectAllowed = "move";
    setDragIndex(idx);
  }

  function handleCardDragOver(e: DragEvent<HTMLDivElement>) {
    if (dragIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function handleCardDrop(e: DragEvent<HTMLDivElement>, dropIdx: number) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/skill-idx");
    const from = raw ? parseInt(raw, 10) : dragIndex;
    if (from === null || Number.isNaN(from)) return;
    moveSkill(from, dropIdx);
    setDragIndex(null);
  }

  function handleDragEnd() {
    setDragIndex(null);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      // Persist description + icon + skills (order preserved via CSV). Hub CLI
      // already accepts these flags together on `bundle update`.
      const initialDesc = bundle?.description ?? "";
      const initialIcon = bundle?.icon ?? "📦";
      const initialSkills = (bundle?.skills ?? []).join(",");
      const args: string[] = ["bundle", "update", bundleName];
      if (desc !== initialDesc) args.push("--description", desc);
      if (icon !== initialIcon) args.push("--icon", icon);
      if (picked.join(",") !== initialSkills)
        args.push("--skills", picked.join(","));

      // Nothing to update — clear dirty and exit.
      if (args.length === 3) {
        setDirty(false);
        return;
      }

      await trackProcess(
        {
          title: `Saving bundle · ${bundleName}`,
          body: "writing bundle definition",
          kind: "batch",
        },
        async () => {
          const result = await invoke<{ success: boolean; output: string }>(
            "hub_cmd",
            { args },
          );
          if (!result.success) throw new Error(result.output);
          await queryClient.invalidateQueries({ queryKey: ["registry"] });
        },
        {
          successBody: `${bundleName} · ${picked.length} skills · projects re-synced`,
          retry: () => void save(),
        },
      );
      setDirty(false);
    } catch {
      /* error surfaced on the process card */
    } finally {
      setSaving(false);
    }
  }

  async function duplicateBundle() {
    const copyName = `${bundleName}-copy`;
    try {
      const args = ["bundle", "new", copyName, "--skills", picked.join(",")];
      if (desc) args.push("--description", desc);
      if (icon) args.push("--icon", icon);
      const result = await invoke<{ success: boolean; output: string }>(
        "hub_cmd",
        { args },
      );
      if (!result.success) throw new Error(result.output);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      toast.success(`Duplicated to "${copyName}"`);
      navigate(`/bundle/${encodeURIComponent(copyName)}`);
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function deleteBundle() {
    setDeleting(true);
    try {
      const result = await invoke<{ success: boolean; output: string }>(
        "hub_cmd",
        { args: ["bundle", "delete", bundleName] },
      );
      if (!result.success) throw new Error(result.output);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      toast.success(`Deleted bundle "${bundleName}"`);
      navigate("/");
    } catch (err) {
      // Keep the dialog open so the user can retry or cancel.
      setDeleting(false);
      toast.error(String(err));
    }
  }

  return (
    <>
      <ScreenHeader
        back={{ label: "Library", onClick: () => navigate("/") }}
        title={
          <span
            className="bundle-glyph header-bundle-glyph"
            style={{ background: color }}
          >
            {icon}
          </span>
        }
        nameMono={bundleName}
        meta={
          <Tag color="var(--fg-mute)" style={{ textTransform: "none" }}>
            {picked.length} skills
          </Tag>
        }
        state={dirty ? <StatePill state="unsaved">UNSAVED</StatePill> : null}
        crumbs={["library", "bundles", bundleName]}
        primary={
          <LoadingButton
            variant="primary"
            icon="save"
            kbd="⌘S"
            onClick={save}
            disabled={!dirty}
            loading={saving}
            loadingLabel="Saving…"
          >
            {dirty ? "Save" : "Saved"}
          </LoadingButton>
        }
        overflow={[
          {
            icon: "copy",
            label: "Duplicate bundle",
            onClick: () => void duplicateBundle(),
          },
          { divider: true },
          {
            icon: "trash",
            label: "Delete bundle",
            danger: true,
            onClick: () => setShowDelete(true),
          },
        ]}
      />

      <ResizableSplit
        className="editor-grid"
        fixedPane="right"
        storageKey="st:layout:bundle-editor"
        defaultRightPx={360}
        minRightPx={280}
        maxRightPx={560}
        handleAriaLabel="Resize side panel"
        paneLabel="Skills"
        left={
        <div className="editor-main">
          <div className="bundle-hero">
            <div className="bundle-glyph" style={{ background: color }}>
              {icon}
            </div>
            <div>
              <Field label="name">
                <div className="readonly-value">{bundleName}</div>
              </Field>
              <Field label="description">
                <textarea
                  rows={2}
                  value={desc}
                  onChange={(e) => {
                    setDesc(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                alignItems: "flex-end",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: ".12em",
                  color: "var(--fg-dim)",
                  textTransform: "uppercase",
                }}
              >
                Applied to
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  justifyContent: "flex-end",
                  maxWidth: 240,
                }}
              >
                {appliedProjects.length === 0 ? (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--fg-dim)",
                    }}
                  >
                    no projects
                  </span>
                ) : (
                  appliedProjects.map((p) => (
                    <Tag
                      key={p}
                      color="var(--fg-mute)"
                      style={{ textTransform: "none", cursor: "pointer" }}
                    >
                      <span
                        onClick={() =>
                          navigate(`/project/${encodeURIComponent(p)}`)
                        }
                      >
                        {p}
                      </span>
                    </Tag>
                  ))
                )}
              </div>
            </div>
          </div>

          <div style={{ padding: "24px 28px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 14,
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  whiteSpace: "nowrap",
                }}
              >
                <Icon name="bundle" size={14} />
                <span style={{ whiteSpace: "nowrap" }}>Bundle contents</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--fg-dim)",
                  }}
                >
                  {picked.length}
                </span>
              </h3>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--fg-dim)",
                  whiteSpace: "nowrap",
                }}
              >
                drag to reorder · ⌫ / ⌘D to remove
              </div>
            </div>

            {picked.length === 0 ? (
              <div
                style={{
                  padding: "28px 16px",
                  textAlign: "center",
                  color: "var(--fg-mute)",
                  fontSize: 12,
                  border: "1px dashed var(--border)",
                  borderRadius: 6,
                }}
              >
                Empty bundle. Add skills from the panel on the right.
              </div>
            ) : (
              <div className="skill-grid">
                {picked.map((skillName, i) => {
                  const skill = allSkills[skillName];
                  if (!skill) return null;
                  return (
                    <div
                      key={skillName}
                      className="bundle-skill-card"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        const isRemove =
                          e.key === "Backspace" ||
                          ((e.metaKey || e.ctrlKey) &&
                            (e.key === "d" || e.key === "D"));
                        if (isRemove) {
                          e.preventDefault();
                          removeSkill(skillName);
                        }
                      }}
                      onDragOver={handleCardDragOver}
                      onDrop={(e) => handleCardDrop(e, i)}
                      onDragEnd={handleDragEnd}
                    >
                      <SkillCard
                        name={skillName}
                        kind={skill.type}
                        scope={skill.scope}
                        description={skill.description}
                        equipped
                        version={skill.version}
                        leadingBadge={
                          <span style={numberBadgeStyle}>
                            {String(i + 1).padStart(2, "0")}
                          </span>
                        }
                        onClick={() =>
                          navigate(`/skill/${encodeURIComponent(skillName)}`)
                        }
                        onUnequipped={() => removeSkill(skillName)}
                        equipToggleTitle="Remove from bundle"
                        draggable
                        onDragStart={(e) =>
                          handleCardDragStart(e, skillName, i)
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="danger-zone">
            <h4>Danger zone</h4>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-mute)",
                marginBottom: 10,
              }}
            >
              Deleting this bundle removes it from all projects. Skills equipped
              only through this bundle will no longer be active until
              re-equipped.
            </div>
            <div className="actions">
              <Button
                variant="danger"
                icon="delete"
                onClick={() => setShowDelete(true)}
              >
                Delete bundle…
              </Button>
            </div>
          </div>
        </div>
        }
        right={
        <div className="editor-side">
          <div className="side-panel-block">
            <h4>Add skills</h4>
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Filter…"
            />
            <div style={{ marginTop: 10 }}>
              {SCOPE_ORDER.map((scope) => {
                const list = filteredAllSkills.filter((s) => s.scope === scope);
                if (list.length === 0) return null;
                return (
                  <div key={scope} style={{ marginBottom: 12 }}>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 9.5,
                        letterSpacing: ".14em",
                        color: "var(--fg-dim)",
                        textTransform: "uppercase",
                        padding: "6px 4px",
                      }}
                    >
                      {SCOPE_LABEL[scope]}
                    </div>
                    {list.map((s) => {
                      const on = picked.includes(s.name);
                      return (
                        <button
                          key={s.name}
                          type="button"
                          className="avail-skill"
                          onClick={() => toggle(s.name)}
                          style={{ paddingLeft: 4 }}
                        >
                          <span
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 3,
                              border: "1px solid var(--border-strong)",
                              background: on ? "var(--violet)" : "transparent",
                              display: "grid",
                              placeItems: "center",
                              flexShrink: 0,
                            }}
                          >
                            {on && (
                              <Icon
                                name="check"
                                size={10}
                                style={{ color: "#fff" }}
                              />
                            )}
                          </span>
                          <span className="name">{s.name}</span>
                          {s.type === "mcp-server" && (
                            <Tag color="var(--amber)" size="sm">
                              MCP
                            </Tag>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        }
        />

      <ConfirmDialog
        open={showDelete}
        title={`Delete bundle "${bundleName}"?`}
        tone="danger"
        confirmLabel="Delete bundle"
        confirmIcon="trash"
        busy={deleting}
        onClose={() => setShowDelete(false)}
        onConfirm={() => {
          void deleteBundle();
        }}
        blastRadius={
          <div className="bundle-delete-blast">
            {appliedProjects.length === 0 ? (
              <p>
                This bundle is not applied to any project. Deleting it removes the
                bundle definition only.
              </p>
            ) : (
              <>
                <p>
                  Applied to{" "}
                  <strong>
                    {appliedProjects.length}{" "}
                    {appliedProjects.length === 1 ? "project" : "projects"}
                  </strong>
                  : <span className="mono">{appliedProjects.join(", ")}</span>
                </p>
                {deactivations.length === 0 ? (
                  <p className="ok">
                    No skills will deactivate — every skill in this bundle stays
                    active via a direct equip or another bundle.
                  </p>
                ) : (
                  <>
                    <p className="warn">
                      <strong>{deactivations.length}</strong> skill{" "}
                      {deactivations.length === 1 ? "activation" : "activations"}{" "}
                      will deactivate ({deactivatingSkills.size} distinct{" "}
                      {deactivatingSkills.size === 1 ? "skill" : "skills"}):
                    </p>
                    <ul className="mono">
                      {appliedProjects.map((p) => {
                        const skills = deactivations
                          .filter((d) => d.project === p)
                          .map((d) => d.skill);
                        if (skills.length === 0) return null;
                        return (
                          <li key={p}>
                            {p} → {skills.join(", ")}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        }
      />
    </>
  );
}
