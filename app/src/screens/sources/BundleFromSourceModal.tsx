import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chips";
import { Field, MetaGrid } from "@/components/Field";
import { IconPicker } from "@/components/IconPicker";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { queryClient } from "@/lib/queryClient";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import {
	bundleWriteLanded,
	errText,
	runRegistryWrite,
	showBundleWarnings,
	type BundleCmdPayload,
} from "@/lib/hubWrite";
import { skillNamesForSource } from "@/lib/skillSource";
import type { SourceView } from "@/types";
import { plural } from "@/screens/sources/sourceFormat";

interface BundleFromSourceModalProps {
	source: SourceView;
	registry: ReturnType<typeof useRegistry>["data"];
	onClose: () => void;
}

export function BundleFromSourceModal({ source, registry, onClose }: BundleFromSourceModalProps) {
	const navigate = useNavigate();
	const toast = useToast();
	const skills = useMemo(
		() => skillNamesForSource(registry, source.id),
		[registry, source.id],
	);
	const [name, setName] = useState(source.id);
	const [description, setDescription] = useState(`Skills from ${source.name}`);
	const [icon, setIcon] = useState("📦");
	const [busy, setBusy] = useState(false);
	// Only an external source can be followed — a built-in has no upstream to
	// reconcile against. Following is the default: "this bundle IS the source"
	// is the mental model people arrive with.
	const linkable = !source.builtin && source.type === "git";
	const [link, setLink] = useState(true);
	const trimmed = name.trim();
	const taken = !!registry?.bundles?.[trimmed];

	async function submit() {
		if (!trimmed || taken || skills.length === 0) return;
		setBusy(true);
		try {
			const args = ["bundle", "new", trimmed, "--skills", skills.join(",")];
			if (description.trim()) args.push("--description", description.trim());
			if (icon.trim()) args.push("--icon", icon.trim());
			if (linkable && link) args.push("--source", source.id);
			args.push("--json");
			// The write and its auto-sync run in one process, so the modal stays
			// open for the whole call — trackProcess reports the wait through the
			// status bar and process tray while it does.
			const { payload, warning } = await trackProcess(
				{
					title: `Creating bundle ${trimmed}`,
					body: "writing bundle · syncing projects",
					kind: "local",
					target: `bundle-new:${trimmed}`,
				},
				() => runRegistryWrite<BundleCmdPayload>(args, bundleWriteLanded),
				{ successBody: `${trimmed} created` },
			);
			await invalidateRegistry(queryClient);
			toast.success(`Bundle "${trimmed}" created with ${plural(skills.length, "skill")}`);
			// Non-fatal notes the CLI attached to a write that DID land — skills
			// dropped because the source doesn't own them, a global-scope link, …
			showBundleWarnings(toast, payload);
			if (warning) toast.info("Sync reported findings", warning);
			onClose();
			navigate(`/bundle/${encodeURIComponent(trimmed)}`);
		} catch (err) {
			toast.error("Couldn't create bundle", errText(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			open
			onClose={onClose}
			title={`Create bundle from "${source.name}"`}
			width={520}
			dismissable={!busy}
			footer={
				<>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						variant="primary"
						icon="check"
						onClick={() => void submit()}
						disabled={busy || !trimmed || taken || skills.length === 0}
						disabledReason={
							taken
								? `A bundle named ${trimmed} already exists.`
								: skills.length === 0
									? "This source has no skills to bundle."
									: undefined
						}
					>
						{busy ? "Creating…" : "Create bundle"}
					</Button>
				</>
			}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<MetaGrid>
					<Field label="name" full>
						<input
							autoFocus
							value={name}
							onChange={(e) => setName(e.target.value)}
							pattern="[a-z0-9\-]+"
							aria-label="Bundle name"
							required
						/>
					</Field>
					<Field label="icon" full>
						<IconPicker value={icon} onChange={setIcon} />
					</Field>
					<Field label="description" full>
						<textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={2}
							aria-label="Bundle description"
						/>
					</Field>
				</MetaGrid>
			</form>
			<div className="source-imported">
				<div className="source-imported-label">
					Skills captured ({skills.length})
				</div>
				<div className="source-imported-list">
					{skills.length === 0 ? (
						<span className="text-dim text-mono">
							This source owns no skills yet.
						</span>
					) : (
						skills.map((s) => <Chip key={s}>{s}</Chip>)
					)}
				</div>
			</div>
			{linkable && (
				<div className="bundle-link-row">
					<Toggle
						checked={link}
						onChange={setLink}
						variant="switch"
						label="Keep in sync with source"
						ariaLabel="Keep in sync with source"
					/>
				</div>
			)}
			<p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-mute)" }}>
				{linkable && link
					? `This bundle follows ${source.name}: syncing the source updates, adds, and removes its skills here.`
					: "This captures the source's skills as they are right now. Skills imported later are not added automatically."}
			</p>
		</Modal>
	);
}
