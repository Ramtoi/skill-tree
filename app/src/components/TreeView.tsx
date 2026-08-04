import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Bundle, Project, Registry } from "@/types";
import {
  bundleProvidedSkills,
  getBundleScope,
  resolveActiveSkills,
  viaBundles,
} from "@/lib/resolveActiveSkills";
import { bundleColor } from "./bundleColors";

// Cap on rendered skill-node labels before the remainder collapses into one
// `+K more` cluster node — keeps the radial graph legible instead of a hairball.
const MAX_VISIBLE_SKILL_NODES = 12;

export interface TreeViewProps {
  project: Project;
  projectName: string;
  registry: Registry;
  onApplyBundle: (name: string) => void;
  onRemoveBundle: (name: string) => void;
  onEnableSkill: (name: string) => void;
  onDisableSkill: (name: string) => void;
}

interface BundleNode {
  id: string;
  bundle: Bundle;
  angle: number;
  x: number;
  y: number;
  active: boolean;
  color: string;
}

interface SkillNode {
  id: string;
  x: number;
  y: number;
  bundleId: string | null;
  equipped: boolean;
  viaBundle: boolean;
  direct: boolean;
  isMcp: boolean;
}

interface LineSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: "bundle-active" | "bundle-idle" | "spoke-active" | "spoke-idle";
}

const TWO_PI = Math.PI * 2;

export function TreeView({
  project,
  projectName,
  registry,
  onApplyBundle,
  onRemoveBundle,
  onEnableSkill,
  onDisableSkill,
}: TreeViewProps) {
  const navigate = useNavigate();

  const { bundleNodes, skillNodes, lines, clusterCount, clusterLabels } =
    useMemo(() => {
    const bundles = Object.entries(registry.bundles ?? {});
    // Equipped + bundle-provided from the shared, global-bundle-aware selectors
    // so a global bundle and its skills draw in the active state (design D1).
    const equippedSet = new Set<string>(resolveActiveSkills(project, registry));
    const bundleProvides = bundleProvidedSkills(project, registry);
    const isBundleActive = (id: string, bundle: Bundle) =>
      project.bundles.includes(id) || getBundleScope(bundle) === "global";

    const bundleNodesLocal: BundleNode[] = bundles.map(([id, bundle], i) => {
      const angle = (i / Math.max(1, bundles.length)) * TWO_PI - Math.PI / 2;
      return {
        id,
        bundle,
        angle,
        x: 50 + Math.cos(angle) * 22,
        y: 50 + Math.sin(angle) * 22,
        active: isBundleActive(id, bundle),
        color: bundleColor(id),
      };
    });

    const skillsAroundBundle: Record<string, SkillNode[]> = {};
    const rendered = new Set<string>();
    bundleNodesLocal.forEach((bn) => {
      const skills = bn.bundle.skills ?? [];
      const n = skills.length;
      const arc = Math.min(0.95, n * 0.13);
      const startAng = bn.angle - arc * Math.PI;
      const around: SkillNode[] = skills
        .filter((sid) => Boolean(registry.skills[sid]))
        .map((sid, i) => {
          const a =
            startAng + (i / Math.max(1, n - 1)) * (arc * 2 * Math.PI);
          const radius = 40;
          const skill = registry.skills[sid];
          return {
            id: sid,
            x: 50 + Math.cos(a) * radius,
            y: 50 + Math.sin(a) * radius,
            bundleId: bn.id,
            equipped: equippedSet.has(sid),
            viaBundle: bundleProvides.has(sid) && bn.active,
            direct: false,
            isMcp: skill?.type === "mcp-server",
          };
        });
      skillsAroundBundle[bn.id] = around;
      around.forEach((s) => rendered.add(s.id));
    });

    const directSkills: SkillNode[] = Object.keys(registry.skills)
      .filter((sid) => equippedSet.has(sid) && !rendered.has(sid))
      .map((sid, i) => {
        const skill = registry.skills[sid];
        return {
          id: sid,
          x: 16 + i * 12,
          y: 88,
          bundleId: null,
          equipped: true,
          viaBundle: false,
          direct: true,
          isMcp: skill?.type === "mcp-server",
        };
      });

    const linesLocal: LineSpec[] = [];
    bundleNodesLocal.forEach((bn) => {
      (skillsAroundBundle[bn.id] ?? []).forEach((s) => {
        linesLocal.push({
          x1: bn.x,
          y1: bn.y,
          x2: s.x,
          y2: s.y,
          kind: bn.active ? "bundle-active" : "bundle-idle",
        });
      });
      linesLocal.push({
        x1: 50,
        y1: 50,
        x2: bn.x,
        y2: bn.y,
        kind: bn.active ? "spoke-active" : "spoke-idle",
      });
    });

    const allSkillNodes: SkillNode[] = [
      ...Object.values(skillsAroundBundle).flat(),
      ...directSkills,
    ];

    // Cap rendered labels; collapse the remainder into a single `+K more` node
    // (deterministic slot — no physics). Truncated names are exposed via the
    // cluster node's title tooltip.
    const visibleNodes = allSkillNodes.slice(0, MAX_VISIBLE_SKILL_NODES);
    const overflow = allSkillNodes.slice(MAX_VISIBLE_SKILL_NODES);
    // Drop skill-edges whose endpoint was clustered away (bundle spokes always
    // stay). Endpoints are matched on their x/y coordinate.
    const visibleCoords = new Set(visibleNodes.map((n) => `${n.x},${n.y}`));
    const prunedLines = linesLocal.filter(
      (l) =>
        l.kind.startsWith("spoke") || visibleCoords.has(`${l.x2},${l.y2}`),
    );

    return {
      bundleNodes: bundleNodesLocal,
      skillNodes: visibleNodes,
      lines: prunedLines,
      clusterCount: overflow.length,
      clusterLabels: overflow.map((n) => n.id),
    };
  }, [project, registry]);

  const bundleProvidedSet = useMemo(
    () => bundleProvidedSkills(project, registry),
    [project, registry],
  );

  function handleBundleClick(id: string) {
    const bundle = registry.bundles[id];
    if (bundle && getBundleScope(bundle) === "global") {
      // Global bundles are auto-applied — not toggleable here; open the bundle
      // detail instead of a dead-end toast (the "never stuck" mechanic).
      navigate(`/bundle/${encodeURIComponent(id)}`);
      return;
    }
    if (project.bundles.includes(id)) {
      onRemoveBundle(id);
    } else {
      onApplyBundle(id);
    }
  }

  function handleSkillClick(id: string) {
    const inDirect = project.enabled.includes(id);
    // A bundle-provided (not directly-equipped) skill can't be toggled from
    // here — navigate to the providing bundle rather than toasting a dead end.
    if (bundleProvidedSet.has(id) && !inDirect) {
      const providers = viaBundles(id, project, registry);
      // Prefer an applied bundle; fall back to any bundle containing it.
      const target =
        providers[0] ??
        Object.entries(registry.bundles).find(([, b]) =>
          (b.skills ?? []).includes(id),
        )?.[0];
      if (target) navigate(`/bundle/${encodeURIComponent(target)}`);
      return;
    }
    if (inDirect) {
      onDisableSkill(id);
    } else {
      onEnableSkill(id);
    }
  }

  return (
    <div className="tree-canvas">
      {/* The stage holds every positioned node; it insets at narrow width so
          edge-node labels stay inside the pane and clear of the legend card. */}
      <div className="tree-stage">
      <svg
        className="tree-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
      >
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            vectorEffect="non-scaling-stroke"
            stroke={
              l.kind === "bundle-active" || l.kind === "spoke-active"
                ? "var(--violet)"
                : "var(--border-strong)"
            }
            strokeWidth={l.kind.endsWith("active") ? 1.6 : 1}
            strokeOpacity={l.kind.endsWith("active") ? 0.6 : 0.25}
            strokeDasharray={l.kind === "spoke-idle" ? "2 3" : "none"}
          />
        ))}
      </svg>

      {/* Center hub */}
      <div
        className="tree-bundle"
        style={{ left: "50%", top: "50%", color: "var(--violet-2)" }}
      >
        <span className="glyph">◈</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-strong)",
            fontWeight: 600,
            letterSpacing: 0,
            maxWidth: 80,
            textAlign: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {projectName}
        </span>
        <span className="lab">core</span>
      </div>

      {/* Bundle hubs */}
      {bundleNodes.map((bn) => (
        <div
          key={bn.id}
          className="tree-bundle"
          data-active={bn.active || undefined}
          data-equipped={bn.active ? "true" : "false"}
          style={{
            left: `${bn.x}%`,
            top: `${bn.y}%`,
            color: bn.color,
            cursor: "pointer",
            width: 78,
            height: 78,
          }}
          onClick={() => handleBundleClick(bn.id)}
          title={bn.bundle.description}
        >
          <span className="glyph" style={{ color: bn.color, fontSize: 18 }}>
            {bn.bundle.icon}
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-strong)", fontWeight: 600 }}>
            {bn.id}
          </span>
          <span className="lab">
            {(bn.bundle.skills ?? []).length}{" "}
            {(bn.bundle.skills ?? []).length === 1 ? "skill" : "skills"}
          </span>
        </div>
      ))}

      {/* Skill nodes */}
      {skillNodes.map((sn) => (
        <div
          key={sn.id + (sn.direct ? "-direct" : `-${sn.bundleId ?? ""}`)}
          className="tree-node"
          data-equipped={
            sn.viaBundle ? "bundle" : sn.equipped ? "true" : "false"
          }
          style={{ left: `${sn.x}%`, top: `${sn.y}%`, width: 110 }}
          onClick={() => handleSkillClick(sn.id)}
          title={`${sn.id}\n${registry.skills[sn.id]?.description ?? ""}`}
        >
          {sn.id.length > 18 ? sn.id.slice(0, 17) + "…" : sn.id}
          {sn.isMcp && (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 8.5,
                color: "var(--amber)",
                letterSpacing: ".12em",
                marginTop: 2,
              }}
            >
              MCP
            </div>
          )}
        </div>
      ))}

      {/* `+K more` cluster node for skills beyond the label cap. */}
      {clusterCount > 0 && (
        <div
          className="tree-node tree-node-cluster"
          data-equipped="false"
          style={{ left: "84%", top: "88%", width: 90 }}
          title={`${clusterCount} more skill${clusterCount === 1 ? "" : "s"}:\n${clusterLabels.join("\n")}`}
        >
          +{clusterCount} more
        </div>
      )}
      </div>

      {/* Legend (top-left) */}
      <div
        className="tree-legend"
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          zIndex: 5,
          background: "var(--bg-glass)",
          backdropFilter: "blur(12px)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "10px 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div
          style={{
            color: "var(--fg-mute)",
            textTransform: "uppercase",
            letterSpacing: ".12em",
            marginBottom: 4,
          }}
        >
          Legend
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background:
                "color-mix(in oklab, var(--amber) 50%, transparent)",
              border:
                "1px solid color-mix(in oklab, var(--amber) 50%, transparent)",
            }}
          />
          <span>direct equip</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background:
                "color-mix(in oklab, var(--violet) 50%, transparent)",
              border:
                "1px solid color-mix(in oklab, var(--violet) 50%, transparent)",
            }}
          />
          <span>provided by bundle</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: "transparent",
              border: "1px solid var(--border-strong)",
              opacity: 0.55,
            }}
          />
          <span>not equipped</span>
        </div>
      </div>

      {/* Hint */}
      <div
        className="tree-hint"
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          zIndex: 5,
          background: "var(--bg-glass)",
          backdropFilter: "blur(12px)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "8px 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: "var(--fg-mute)",
          whiteSpace: "nowrap",
        }}
      >
        click a bundle to (un)apply · click a skill to (un)equip
      </div>
    </div>
  );
}
