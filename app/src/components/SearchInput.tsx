import { type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Icon } from "./Icon";

export interface SearchInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  leadingIconSize?: number;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Marks this as the screen's primary search box for the `/` hotkey. */
  screenSearch?: boolean;
  /** `data-testid` stamped on the <input> itself (not the wrapper), so a test
   *  or an e2e journey can type into it without a structural selector. */
  inputTestId?: string;
  /** Rendered between the leading search icon and the input — a mode pill
   *  (e.g. FloatingSearch's active-kind chip), never a replacement for the
   *  icon. */
  leading?: ReactNode;
  /** Replaces the trailing `/` hint (e.g. a clear button). */
  trailing?: ReactNode;
  /** Extra attributes for the <input>. Controlled props always win. */
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "placeholder" | "onKeyDown"
  >;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  onKeyDown,
  leadingIconSize,
  className,
  inputRef,
  screenSearch,
  inputTestId,
  leading,
  trailing,
  inputProps,
}: SearchInputProps) {
  return (
    <div
      className={`search-input${className ? ` ${className}` : ""}`}
      data-screen-search={screenSearch ? "" : undefined}
    >
      <Icon name="search" size={leadingIconSize ?? 14} />
      {leading}
      <input
        {...inputProps}
        ref={inputRef}
        data-testid={inputTestId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
      />
      {trailing ?? <span className="slash">/</span>}
    </div>
  );
}
