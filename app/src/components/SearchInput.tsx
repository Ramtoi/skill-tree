import { type KeyboardEvent, type Ref } from "react";
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
}: SearchInputProps) {
  return (
    <div
      className={`search-input${className ? ` ${className}` : ""}`}
      data-screen-search={screenSearch ? "" : undefined}
    >
      <Icon name="search" size={leadingIconSize ?? 14} />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
      />
      <span className="slash">/</span>
    </div>
  );
}
