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
}: SearchInputProps) {
  return (
    <div className={`search-input${className ? ` ${className}` : ""}`}>
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
