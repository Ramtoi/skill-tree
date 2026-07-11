import { Button, type ButtonProps } from "@/components/Button";

export interface LoadingButtonProps extends ButtonProps {
  loading?: boolean;
  /** Visible label while loading. Defaults to the original children. */
  loadingLabel?: string;
}

/** Thin wrapper over `<Button busy>` that also swaps the visible label while
 *  loading (gerund + percent when known, e.g. "Syncing… 42%"). The busy visual
 *  — leading spinner, disable, `.is-loading`, `aria-busy` — lives in the Button
 *  primitive so every control shares ONE pattern. */
export function LoadingButton({
  loading,
  loadingLabel,
  disabled,
  children,
  ...rest
}: LoadingButtonProps) {
  return (
    <Button {...rest} busy={loading} disabled={disabled}>
      {loading && loadingLabel ? loadingLabel : children}
    </Button>
  );
}
