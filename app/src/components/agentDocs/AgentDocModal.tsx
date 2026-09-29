import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { stopEvent } from "@/lib/pressable";

// ─── Modal ──────────────────────────────────────────────────────────────────
// Renamed from the local `Modal` to avoid colliding with `@/components/Modal`.

export function AgentDocModal({
	title,
	accent = "amber",
	onClose,
	actions,
	children,
}: {
	title: string;
	accent?: "amber" | "red";
	onClose: () => void;
	actions: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="ad-modal-backdrop" role="presentation" onClick={onClose}>
			{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- onClick only stops the backdrop's close-on-click from firing for clicks inside the dialog; role="dialog" already carries the real interaction semantics. */}
			<div
				className="ad-modal"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				data-accent={accent}
				onClick={stopEvent}
			>
				<div className="ad-modal-head">
					<Icon name="warning" size={14} />
					<span>{title}</span>
				</div>
				<div className="ad-modal-body">{children}</div>
				<div className="ad-modal-foot">{actions}</div>
			</div>
		</div>
	);
}
