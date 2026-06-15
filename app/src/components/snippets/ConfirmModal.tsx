import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/Button";
import { Icon } from "@/components/Icon";

export interface ConfirmModalProps {
	title: string;
	accent?: "amber" | "red";
	icon?: string;
	confirmLabel: string;
	confirmVariant?: ButtonVariant;
	confirmIcon?: string;
	onClose: () => void;
	onConfirm: () => void;
	children: ReactNode;
}

/** Accent-bordered confirm dialog reusing the `.ad-modal` chrome. */
export function ConfirmModal({
	title,
	accent = "amber",
	icon = "warning",
	confirmLabel,
	confirmVariant = "primary",
	confirmIcon,
	onClose,
	onConfirm,
	children,
}: ConfirmModalProps) {
	return (
		<div className="ad-modal-backdrop" onClick={onClose}>
			<div
				className="ad-modal"
				data-accent={accent}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="ad-modal-head">
					<Icon name={icon} size={14} />
					<span>{title}</span>
				</div>
				<div className="ad-modal-body">{children}</div>
				<div className="ad-modal-foot">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button variant={confirmVariant} icon={confirmIcon} onClick={onConfirm}>
						{confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}
