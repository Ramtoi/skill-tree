import { useNavigate } from "react-router-dom";

import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { SectionHeader } from "@/components/SectionHeader";
import { bundleColor } from "@/components/bundleColors";
import { CloudStatusBadge } from "@/components/cloud/CloudStatusBadge";
import { useAlsoServed, useCloudTargets, CHATGPT_DESKTOP } from "@/hooks/useCloud";
import { driftCluster, type CloudTarget } from "@/lib/cloud";
import { relTime } from "@/lib/syncFreshness";
import { clickSink } from "@/lib/pressable";

/**
 * The "Cloud apps" band on the Remotes screen.
 *
 * These are not remotes — nothing connects, nothing syncs — but they answer the
 * same question ("what is equipped off this machine, and is it stale?"), so
 * they live on the same surface instead of earning a rail slot for a job done
 * once in a while. The card is deliberately zero-click: the drift cluster is
 * the whole point, and opening the target is the only action it offers.
 */
export function CloudAppsSection() {
	const navigate = useNavigate();
	const { data: targets, isLoading, error } = useCloudTargets();
	const { data: desktopServers } = useAlsoServed(CHATGPT_DESKTOP);

	return (
		<section className="cloud-section" data-testid="cloud-apps">
			{/* No count: the band also holds the desktop-app info card, which is
			    not a target you can equip — a number here would contradict the
			    cards below it. */}
			<SectionHeader label="Cloud apps" />
			<p className="cloud-section-lede">
				Skills reach claude.ai and ChatGPT by manual ZIP upload — those
				products have no API to sync into. Hub builds the ZIP and remembers
				what you last exported.
			</p>

			{error ? (
				<div className="cloud-section-hint" data-testid="cloud-error">
					Couldn&apos;t load cloud targets — {String(error)}
				</div>
			) : isLoading ? (
				<div className="cloud-section-hint">Loading cloud targets…</div>
			) : (
				<div className="cloud-grid">
					{(targets ?? []).map((t) => (
						<CloudCard
							key={t.id}
							target={t}
							onOpen={() => navigate(`/cloud/${encodeURIComponent(t.id)}`)}
						/>
					))}
					{(desktopServers ?? []).length > 0 && (
						<ChatGptDesktopCard
							harnessLabel={desktopServers?.[0]?.label ?? "codex"}
							onOpenHarnesses={() => navigate("/harnesses")}
						/>
					)}
				</div>
			)}
		</section>
	);
}

function CloudCard({
	target,
	onOpen,
}: {
	target: CloudTarget;
	onOpen: () => void;
}) {
	const cluster = driftCluster(target.drift, target.equipped);
	return (
		<div
			className="cloud-card"
			data-target={target.id}
			onClick={onOpen}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") onOpen();
			}}
		>
			<div className="cloud-card-head">
				{/* Identity register only: the low-chroma `--id-*` ramp, so two cards
				    that share the same cloud glyph are still told apart at a glance
				    without borrowing a status or brand hue. The glyph is `cloud`,
				    not `globe` — that one means scope.global everywhere else. */}
				<span
					className="cloud-card-glyph"
					style={{ color: bundleColor(target.id) }}
				>
					<Icon name="cloud" size={20} />
				</span>
				<div className="cloud-card-id">
					<div className="cloud-card-name">{target.label}</div>
					<div className="cloud-card-sub text-mono">{target.id}</div>
				</div>
			</div>

			{/* Only what a glance can use. The in-product upload breadcrumb lived
			    here and truncated to nothing at every width — it belongs on the
			    detail screen, next to the export that produces the ZIPs. */}
			<div className="cloud-card-meta">
				<div className="cloud-meta-row">
					<span>equipped</span>
					<span className="text-mono">
						{target.equipped} skill{target.equipped === 1 ? "" : "s"}
					</span>
				</div>
				{/* The most useful glance fact after drift. Deliberately "last
				    exported", not "last synced": hub knows when it BUILT the ZIPs and
				    nothing about whether they were ever uploaded. */}
				<div className="cloud-meta-row">
					<span>last exported</span>
					<span
						className="text-mono"
						title={target.last_exported ?? undefined}
						data-testid={`cloud-last-exported-${target.id}`}
					>
						{target.last_exported ? relTime(target.last_exported) : "never"}
					</span>
				</div>
			</div>

			<div className="cloud-card-drift" data-testid={`cloud-drift-${target.id}`}>
				{cluster.length > 0 ? (
					cluster.map((c) => (
						<CloudStatusBadge key={c.status} status={c.status} count={c.count} />
					))
				) : (
					<span className="cloud-card-idle">Nothing equipped yet</span>
				)}
			</div>

			<div className="cloud-card-foot" {...clickSink()}>
				<Button variant="ghost" size="sm" icon="arrow-right" onClick={onOpen}>
					Open
				</Button>
			</div>
		</div>
	);
}

/**
 * The zero-work path, made legible. The ChatGPT DESKTOP app reads
 * `~/.agents/skills`, which the codex harness already writes — so it needs no
 * export, no upload, and no card action. Saying so is the point: an invisible
 * automatic path the user doesn't trust is one they will do by hand anyway.
 *
 * The copy names the ONE condition. `~/.agents/skills` is the harness's GLOBAL
 * skills dir, written only for `scope: global` skills; a project equip writes
 * `<repo>/.agents/skills` instead. The card used to say "equip through a
 * project", which sends the user down a path that cannot reach this app.
 */
function ChatGptDesktopCard({
	harnessLabel,
	onOpenHarnesses,
}: {
	harnessLabel: string;
	onOpenHarnesses: () => void;
}) {
	return (
		<div className="cloud-card cloud-card-info" data-testid="chatgpt-desktop-card">
			<div className="cloud-card-head">
				<span className="cloud-card-glyph">
					<Icon name="plug" size={20} />
				</span>
				<div className="cloud-card-id">
					<div className="cloud-card-name">ChatGPT desktop app</div>
					<div className="cloud-card-sub">No upload needed</div>
				</div>
			</div>
			<p className="cloud-card-note">
				Managed automatically via the {harnessLabel} harness, which writes{" "}
				<span className="text-mono">~/.agents/skills</span> — the folder the
				desktop app reads. Give a skill{" "}
				<span className="text-mono">scope: global</span> to land it there; a
				project equip writes{" "}
				<span className="text-mono">&lt;repo&gt;/.agents/skills</span> instead
				and reaches the desktop app only inside that repo.
			</p>
			<div className="cloud-card-foot">
				<Button
					variant="ghost"
					size="sm"
					icon="arrow-right"
					onClick={onOpenHarnesses}
				>
					Open harnesses
				</Button>
			</div>
		</div>
	);
}
