import { attentionLine } from "@/lib/navAttention";
// Dev-only primitive styleguide — every atom in every state, on one page.
// Iteration surface for the primitives redesign: change a token or an atom,
// recapture this one scene, judge the frame. Not linked from any nav surface;
// reachable at /#/styleguide.
import { useEffect, useRef, useState } from "react";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { Tag, KindTag, KindMark, ScopeBadge } from "@/components/Tag";
import { Kbd } from "@/components/Kbd";
import { Chips, Chip } from "@/components/Chips";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/StatusBadge";
import { StatePill } from "@/components/StatePill";
import { Plaque } from "@/components/Plaque";
import { RiskBadge } from "@/components/RiskBadge";
import { FreshnessBadge, FreshnessDot } from "@/components/FreshnessBadge";
import { SearchInput } from "@/components/SearchInput";
import { SectionHeader } from "@/components/SectionHeader";
import { StatCard } from "@/components/StatCard";
import { ResourceRow, ResourceCard } from "@/components/ResourceRow";
import { BundleChip, BundleChipAdd } from "@/components/BundleChip";
import { EmptyState } from "@/components/EmptyState";
import { DescriptionMeter } from "@/components/DescriptionMeter";
import { PowerPips } from "@/components/PowerPips";
import { bundleColor } from "@/components/bundleColors";
import { SideRow } from "@/components/nav/SidePrimitives";
import { SideStats } from "@/components/nav/SideStat";
import { SideAttention } from "@/components/nav/SideAttention";
import { SideDetail, type DetailRow, type DetailLine } from "@/components/nav/SideDetail";
import type { SideStatProps, AttentionLine } from "@/lib/navInsights";

const ICON_SAMPLER = [
  "skill",
  "mcp",
  "bundle",
  "project",
  "source",
  "library",
  "snippet",
  "hook",
  "permissions",
  "harness",
  "remote",
  "usage",
  "command",
  "tweaks",
  "scope.global",
  "scope.portable",
  "scope.project",
  "state.ok",
  "state.syncing",
  "state.error",
  "view.grid",
  "view.list",
  "equip",
  "sync",
  "save",
  "edit",
  "delete",
  "search",
  "plus",
  "check",
];

function Section({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section className="sg-section" data-sg={id}>
      <SectionHeader label={label} />
      <div className="sg-body">{children}</div>
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sg-specimen">
      <div className="sg-specimen-demo">{children}</div>
      <div className="sg-specimen-label">{label}</div>
    </div>
  );
}

const noop = () => {};

// ─── Navigator specimens (NAV-DASHBOARD-SPEC.md §5.8) ───────────────────────
const NAV_TILES_STEADY: [SideStatProps, SideStatProps] = [
  { label: "IN SYNC", value: "3/3", sub: "nothing pending", title: "3/3 in sync · nothing pending" },
  { label: "LAST SYNC", value: "2h ago", sub: "10 writes", title: "generated 2h ago · 10 writes" },
];
const NAV_TILES_EMPTY: [SideStatProps, SideStatProps] = [
  { label: "IN SYNC", value: "—", sub: "run sync", title: "no sync report yet" },
  { label: "LAST SYNC", value: "—", sub: "run sync", title: "no sync report yet" },
];
const NAV_TILES_ERROR_SUB: [SideStatProps, SideStatProps] = [
  { label: "IN SYNC", value: "0/3", sub: "1 failed", subTone: "error", title: "1 failed · 1 stale · 1 unknown" },
  { label: "LAST SYNC", value: "2h ago", sub: "10 writes", title: "generated 2h ago · 10 writes" },
];

const NAV_ATTENTION_LINES: AttentionLine[] = [
  attentionLine("projects.failed", "error", "2 project syncs failed", [
    { id: "example-app", label: "example-app", detail: "The skill folder could not be written.", action: { label: "Open project", href: "/project/example-app" } },
    { id: "moon-base", label: "moon-base", detail: "The skill folder could not be written.", action: { label: "Open project", href: "/project/moon-base" } },
  ]),
  attentionLine("guardrails.hookSudo", "error", "audit-bash runs sudo", [{ id: "audit-bash", label: "audit-bash", detail: "sudo audit.sh", action: { label: "Inspect hook", href: "/hook/audit-bash" } }]),
  attentionLine("projects.stale", "warn", "moon-base needs a re-sync", [{ id: "moon-base", label: "moon-base", action: { label: "Open project", href: "/project/moon-base" } }]),
  attentionLine("guardrails.permissionsStreamFailed", "error", "Permission sync failed", [{ id: "global", label: "Global permission files" }], { label: "Open Permissions", href: "/permissions" }),
];

const NAV_DETAIL_ROWS: DetailRow[] = [
  { key: "sg.d1", leading: <Icon name="bundle" size={12} />, name: "android", count: 3, href: "/styleguide" },
  { key: "sg.d2", leading: <Icon name="bundle" size={12} />, name: "openspec", count: 2, href: "/styleguide" },
];
const NAV_DETAIL_LINES: DetailLine[] = [
  { key: "sg.dl1", tone: "error", text: "retired-skill — not in the registry" },
];

/** Focuses its one row on mount so `:focus-visible` is photographed without a
 *  pointer interaction to fake — the same contract as a real keyboard entry
 *  (`g ⇧n` / roving tabindex), just triggered at mount instead of a chord. */
function FocusedSideRow() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[data-side-row]")?.focus();
  }, []);
  return (
    <div ref={ref}>
      <SideRow name="focused-row" count={3} title="focused-row" onClick={noop} />
    </div>
  );
}

export function Styleguide() {
  const [checks, setChecks] = useState<Record<string, boolean>>({ a: true, sw: true });
  const [chip, setChip] = useState("all");
  const [search, setSearch] = useState("");
  const check = (k: string) => checks[k] ?? false;
  const setCheck = (k: string) => (v: boolean) => setChecks((c) => ({ ...c, [k]: v }));

  return (
    <>
      <ScreenHeader
        icon="tweaks"
        title="Styleguide"
        subline="Every primitive, every state — the redesign iteration surface"
      />
      <div className="main-body">
        <div className="screen-pad sg-root">
          <Section id="buttons" label="Button — variants × sizes × states">
            <div className="sg-grid">
              <Specimen label="ghost md"><Button onClick={noop}>Ghost</Button></Specimen>
              <Specimen label="soft md"><Button variant="soft" onClick={noop}>Soft</Button></Specimen>
              <Specimen label="primary md"><Button variant="primary" onClick={noop}>Primary</Button></Specimen>
              <Specimen label="danger md"><Button variant="danger" onClick={noop}>Danger</Button></Specimen>
              <Specimen label="sm"><Button size="sm" onClick={noop}>Small</Button></Specimen>
              <Specimen label="lg primary"><Button size="lg" variant="primary" onClick={noop}>Large</Button></Specimen>
              <Specimen label="icon + label"><Button icon="sync" onClick={noop}>Sync</Button></Specimen>
              <Specimen label="icon-only"><Button icon="edit" title="Edit" onClick={noop} /></Specimen>
              <Specimen label="kbd hint"><Button variant="primary" kbd="⌘S" onClick={noop}>Save</Button></Specimen>
              <Specimen label="signal dot"><Button variant="primary" signal="dot" title="Unsaved changes" onClick={noop}>Save</Button></Specimen>
              <Specimen label="busy"><Button variant="primary" busy onClick={noop}>Saving</Button></Specimen>
              <Specimen label="disabled"><Button disabled onClick={noop}>Disabled</Button></Specimen>
              <Specimen label="disabledReason"><Button disabled disabledReason="Nothing selected" onClick={noop}>Inert</Button></Specimen>
            </div>
          </Section>

          <Section id="toggles" label="Toggle — the one checkbox/switch">
            <div className="sg-grid">
              <Specimen label="checkbox md"><Toggle checked={check("a")} onChange={setCheck("a")} label="Checkbox" /></Specimen>
              <Specimen label="checkbox sm"><Toggle size="sm" checked={check("b")} onChange={setCheck("b")} label="Small" /></Specimen>
              <Specimen label="indeterminate"><Toggle checked={false} indeterminate onChange={noop} label="Some selected" /></Specimen>
              <Specimen label="disabled"><Toggle checked disabled onChange={noop} label="Locked" /></Specimen>
              <Specimen label="switch md"><Toggle variant="switch" checked={check("sw")} onChange={setCheck("sw")} label="Switch" /></Specimen>
              <Specimen label="switch off"><Toggle variant="switch" checked={check("sw2")} onChange={setCheck("sw2")} label="Off" /></Specimen>
              <Specimen label="switch sm disabled"><Toggle variant="switch" size="sm" checked disabled onChange={noop} label="Locked" /></Specimen>
            </div>
          </Section>

          <Section id="tags" label="Tag / KindTag / ScopeBadge / Kbd">
            <div className="sg-grid">
              <Specimen label="soft"><Tag color="var(--anchor-2)">soft</Tag></Specimen>
              <Specimen label="solid"><Tag kind="solid" color="var(--green)">solid</Tag></Specimen>
              <Specimen label="outline"><Tag kind="outline" color="var(--amber)">outline</Tag></Specimen>
              <Specimen label="sm"><Tag size="sm" color="var(--cyan)">sm tag</Tag></Specimen>
              <Specimen label="KindTag SKILL"><KindTag kind="SKILL" /></Specimen>
              <Specimen label="KindTag MCP"><KindTag kind="MCP" /></Specimen>
              <Specimen label="KindMark MCP (icon-only)"><KindMark kind="MCP" /></Specimen>
              <Specimen label="KindMark SKILL (renders nothing)"><KindMark kind="SKILL" /></Specimen>
              <Specimen label="scope global"><ScopeBadge scope="global" /></Specimen>
              <Specimen label="scope portable"><ScopeBadge scope="portable" /></Specimen>
              <Specimen label="scope project"><ScopeBadge scope="project" /></Specimen>
              <Specimen label="Kbd"><Kbd>⌘K</Kbd></Specimen>
            </div>
          </Section>

          <Section id="chips" label="Chips — filter / view toggles">
            <div className="sg-grid">
              <Specimen label="chip row">
                <Chips>
                  <Chip pressed={chip === "all"} onClick={() => setChip("all")} count={40}>ALL</Chip>
                  <Chip pressed={chip === "skill"} onClick={() => setChip("skill")} icon="skill" count={32}>SKILL</Chip>
                  <Chip pressed={chip === "mcp"} onClick={() => setChip("mcp")} icon="mcp" count={8}>MCP</Chip>
                  <Chip pressed={chip === "dot"} onClick={() => setChip("dot")} dotColor="var(--id-3)">android</Chip>
                </Chips>
              </Specimen>
            </div>
          </Section>

          <Section id="badges" label="StatusBadge — channel × shape × motion">
            <div className="sg-grid">
              {(["ok", "info", "warn", "error", "neutral"] as const).map((ch) => (
                <Specimen key={ch} label={`${ch} pill`}><StatusBadge channel={ch} shape="pill">{ch}</StatusBadge></Specimen>
              ))}
              <Specimen label="ok dot"><StatusBadge channel="ok" shape="dot">synced</StatusBadge></Specimen>
              <Specimen label="neutral ring"><StatusBadge channel="neutral" shape="ring">stale</StatusBadge></Specimen>
              <Specimen label="neutral pulse"><StatusBadge channel="neutral" shape="dot" motion="pulse">syncing</StatusBadge></Specimen>
              <Specimen label="icon pill"><StatusBadge channel="error" shape="pill" icon="state.error">error</StatusBadge></Specimen>
            </div>
          </Section>

          <Section id="badge-presets" label="Badge presets — StatePill / RiskBadge / Freshness">
            <div className="sg-grid">
              <Specimen label="unsaved"><StatePill state="unsaved">UNSAVED</StatePill></Specimen>
              <Specimen label="readonly"><StatePill state="readonly" icon="link">READ-ONLY</StatePill></Specimen>
              <Specimen label="saved"><StatePill state="saved" icon="check">saved</StatePill></Specimen>
              <Specimen label="info"><StatePill state="info">info</StatePill></Specimen>
              <Specimen label="risk danger"><RiskBadge code="HOOK_RUNS_SUDO" severity="danger" explanation="A hook invokes sudo" /></Specimen>
              <Specimen label="risk warning"><RiskBadge code="BROAD_ALLOW" severity="warning" explanation="Unbounded allow rule" /></Specimen>
              <Specimen label="fresh"><FreshnessBadge state="fresh" /></Specimen>
              <Specimen label="stale"><FreshnessBadge state="stale" /></Specimen>
              <Specimen label="error"><FreshnessBadge state="error" /></Specimen>
              <Specimen label="unknown"><FreshnessBadge state="unknown" /></Specimen>
              <Specimen label="dot only"><FreshnessDot state="fresh" /></Specimen>
            </div>
          </Section>

          <Section id="plaque" label="Plaque — accent register">
            <div className="sg-grid">
              <Specimen label="anchor">
                <div className="sg-plaque-frame">
                  <Plaque eyebrow="External source" accent="anchor">
                    <p className="source-banner-copy">Read-only — synced from the org repo.</p>
                  </Plaque>
                </div>
              </Specimen>
              <Specimen label="amber">
                <div className="sg-plaque-frame">
                  <Plaque eyebrow="Starter Pack" accent="amber">
                    <p className="source-banner-copy">Read-only — bundled with Skill Tree.</p>
                  </Plaque>
                </div>
              </Specimen>
              <Specimen label="red">
                <div className="sg-plaque-frame">
                  <Plaque eyebrow="Dropped upstream" accent="red">
                    <p className="source-banner-copy">The source no longer has this skill.</p>
                  </Plaque>
                </div>
              </Specimen>
            </div>
          </Section>

          <Section id="inputs" label="SearchInput / meters / pips">
            <div className="sg-grid">
              <Specimen label="search">
                <SearchInput value={search} onChange={setSearch} placeholder="Search skills…" />
              </Specimen>
              <Specimen label="DescriptionMeter ok"><DescriptionMeter value={"A tidy description".repeat(2)} /></Specimen>
              <Specimen label="DescriptionMeter warn"><DescriptionMeter value={"Long description ".repeat(13)} /></Specimen>
              <Specimen label="PowerPips 3/5"><PowerPips on={3} total={5} /></Specimen>
            </div>
          </Section>

          <Section id="statcards" label="StatCard — hero strip">
            <div className="sg-grid sg-grid-cards tile-row">
              <StatCard label="EQUIPPED" value={10} sub="8 direct · 2 via bundles" accent />
              <StatCard label="SKILLS" value={8} sub="2 MCP servers" />
              <StatCard label="BUNDLES" value={2} sub="android · openspec" />
              {/* Status is never display type: a status-shaped value renders in
                  the freshness-badge register, not hero numerals. */}
              <StatCard label="SYNC" value={<FreshnessBadge state="fresh" label="up to date" />} sub=".claude · .agents aligned" />
            </div>
          </Section>

          <Section id="rows" label="ResourceRow — list anatomy">
            <div className="sg-stack">
              <ResourceRow
                glyph={<ScopeBadge scope="global" />}
                name="unslop"
                meta={<KindTag kind="SKILL" />}
                desc="Cut AI tells from any writing. Must always apply."
                badges={<StatusBadge channel="ok" shape="dot">3</StatusBadge>}
                actions={<><Button size="sm" icon="edit" title="Edit" onClick={noop} /><Button size="sm" icon="equip" title="Equip" onClick={noop} /></>}
                onClick={noop}
              />
              <ResourceRow
                glyph={<ScopeBadge scope="portable" />}
                name="review-workflow"
                meta={<KindTag kind="SKILL" />}
                desc="How Rafa likes a review — structured multi-pass."
                onClick={noop}
                selected
              />
              <ResourceRow
                glyph={<ScopeBadge scope="project" />}
                name="context7"
                meta={<KindTag kind="MCP" />}
                desc="Live library docs lookup over MCP."
                badges={<StatusBadge channel="neutral" shape="ring">0</StatusBadge>}
                onClick={noop}
              />
            </div>
          </Section>

          <Section id="navigator" label="Navigator — tiles, attention plaque, expanded row">
            <div className="sg-grid">
              <Specimen label="tiles — steady">
                <div className="sg-nav-frame">
                  <SideStats tiles={NAV_TILES_STEADY} />
                </div>
              </Specimen>
              <Specimen label="tiles — empty">
                <div className="sg-nav-frame">
                  <SideStats tiles={NAV_TILES_EMPTY} />
                </div>
              </Specimen>
              <Specimen label="tiles — sub error tone">
                <div className="sg-nav-frame">
                  <SideStats tiles={NAV_TILES_ERROR_SUB} />
                </div>
              </Specimen>
            </div>
            <div className="sg-grid">
              <Specimen label="attention plaque — 2 error + 2 warn, +1 more">
                <div className="sg-nav-frame">
                  <SideAttention lines={NAV_ATTENTION_LINES} groupLabel="Styleguide" />
                </div>
              </Specimen>
            </div>
            <div className="sg-grid">
              <Specimen label="row hint — warn">
                <div className="sg-nav-frame">
                  <SideRow name="moon-base" count={8} hint="re-sync" hintTone="warn" onClick={noop} />
                </div>
              </Specimen>
              <Specimen label="row hint — error">
                <div className="sg-nav-frame">
                  <SideRow name="example-app" count={4} hint="failed" hintTone="error" onClick={noop} />
                </div>
              </Specimen>
              <Specimen label="row hint — severity">
                <div className="sg-nav-frame">
                  <SideRow name="skill-hub" count={1} hint="trust" hintTone="severity" onClick={noop} />
                </div>
              </Specimen>
            </div>
            <div className="sg-grid">
              <Specimen label="expanded row — 2 nested rows + 1 line">
                <div className="sg-nav-frame">
                  <SideRow
                    name="moon-base"
                    count={8}
                    hint="re-sync"
                    hintTone="warn"
                    active
                    onClick={noop}
                    detail={
                      <SideDetail
                        rows={NAV_DETAIL_ROWS}
                        lines={NAV_DETAIL_LINES}
                        currentPath="/styleguide"
                      />
                    }
                  />
                </div>
              </Specimen>
              <Specimen label="focus ring — :focus-visible">
                <div className="sg-nav-frame">
                  <FocusedSideRow />
                </div>
              </Specimen>
            </div>
          </Section>

          <Section id="cards" label="ResourceCard / skill-card states">
            <div className="sg-grid sg-grid-cards tile-row">
              <ResourceCard
                className="skill-card"
                glyph={<ScopeBadge scope="global" />}
                name="unslop"
                meta={<KindTag kind="SKILL" />}
                desc="Cut AI tells from any writing. Must always apply."
                footer={<span>starter · v3</span>}
                onClick={noop}
              />
              <ResourceCard
                className="skill-card"
                dataset={{ equipped: "true" }}
                glyph={<ScopeBadge scope="portable" />}
                name="grill"
                meta={<KindTag kind="SKILL" />}
                desc="Critical review and devil's advocate for any idea."
                footer={<span>local · v1</span>}
                onClick={noop}
              />
              <ResourceCard
                className="skill-card"
                dataset={{ via: "bundle" }}
                glyph={<ScopeBadge scope="portable" />}
                name="leggo"
                meta={<KindTag kind="SKILL" />}
                desc="End-to-end feature pipeline with quality gates."
                footer={<span>via android</span>}
                onClick={noop}
              />
              <ResourceCard
                className="skill-card"
                dataset={{ dim: "true" }}
                glyph={<ScopeBadge scope="global" />}
                name="brainstorm"
                meta={<KindTag kind="SKILL" />}
                desc="Structured multi-round deliberation."
                footer={<span>starter · v2</span>}
                onClick={noop}
              />
            </div>
          </Section>

          <Section id="bundles" label="BundleChip">
            <div className="sg-grid">
              <Specimen label="chip"><BundleChip name="android" icon="📦" count={6} color={bundleColor("android")} onClick={noop} /></Specimen>
              <Specimen label="removable"><BundleChip name="openspec" icon="📐" count={9} color={bundleColor("openspec")} onClick={noop} onRemove={noop} /></Specimen>
              <Specimen label="add"><BundleChipAdd available={[{ name: "web", icon: "🌐", count: 4, color: bundleColor("web") }]} onPick={noop}>Apply bundle</BundleChipAdd></Specimen>
            </div>
          </Section>

          <Section id="empty" label="EmptyState">
            <div className="sg-frame">
              <EmptyState
                icon="library"
                title="No skills match"
                description="Clear a filter or create a new skill."
                action={<Button variant="primary" onClick={noop}>New skill</Button>}
              />
            </div>
          </Section>

          <Section id="icons" label="Icon sampler">
            <div className="sg-grid sg-grid-icons">
              {ICON_SAMPLER.map((k) => (
                <Specimen key={k} label={k}><Icon name={k} /></Specimen>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
