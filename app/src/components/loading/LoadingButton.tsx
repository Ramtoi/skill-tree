import { Button, type ButtonProps } from "@/components/Button";
import { Spinner } from "./Spinner";

export interface LoadingButtonProps extends ButtonProps {
  loading?: boolean;
  /** Visible label while loading. Defaults to the original children. */
  loadingLabel?: string;
}

/** Button that swaps its icon for a spinner and disables itself while loading.
 *  Label pattern: gerund + percent when known (e.g. "Syncing… 42%"). */
export function LoadingButton({
  loading,
  loadingLabel,
  icon,
  children,
  disabled,
  className,
  ...rest
}: LoadingButtonProps) {
  return (
    <Button
      {...rest}
      icon={loading ? undefined : icon}
      leading={loading ? <Spinner size={12} color="currentColor" /> : undefined}
      disabled={loading || disabled}
      className={`${className ?? ""}${loading ? " is-loading" : ""}`.trim() || undefined}
    >
      {loading && loadingLabel ? loadingLabel : children}
    </Button>
  );
}
