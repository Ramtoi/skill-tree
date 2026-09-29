import { useState } from "react";
import { Button } from "@/components/Button";
import { Field, MetaGrid } from "@/components/Field";
import { Modal } from "@/components/Modal";
import type { SourceView } from "@/types";

interface RenameSourceModalProps {
	source: SourceView;
	busy?: boolean;
	onClose: () => void;
	onSubmit: (name: string) => void;
}

export function RenameSourceModal({ source, busy, onClose, onSubmit }: RenameSourceModalProps) {
	const [name, setName] = useState(source.name);
	const trimmed = name.trim();
	const canSave = trimmed.length > 0 && trimmed !== source.name && !busy;
	return (
		<Modal
			open
			onClose={onClose}
			title={`Rename "${source.name}"`}
			width={420}
			dismissable={!busy}
			footer={
				<>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						variant="primary"
						icon="check"
						onClick={() => onSubmit(trimmed)}
						disabled={!canSave}
					>
						Save name
					</Button>
				</>
			}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (canSave) onSubmit(trimmed);
				}}
			>
				<MetaGrid>
					<Field label="display name" full>
						<input
							autoFocus
							value={name}
							onChange={(e) => setName(e.target.value)}
							aria-label="Source display name"
						/>
					</Field>
				</MetaGrid>
			</form>
			<p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-mute)" }}>
				Display only — the source id{" "}
				<span className="text-mono">{source.id}</span> never changes, so nothing
				that references it breaks.
			</p>
		</Modal>
	);
}
