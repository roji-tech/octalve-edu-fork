import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "./icons";

export type SelectOption = { value: string; label: string };

export type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> & {
  label: string;
  id?: string;
  options: readonly SelectOption[];
  hint?: string;
  error?: string | null;
  /// Visually hide the label (it stays the accessible name) — for a filter bar where the select's first option says it all.
  hideLabel?: boolean;
  children?: ReactNode;
};

/// A labelled native <select>, wired like TextField: a real <label htmlFor>, hint/error linked by aria-describedby, aria-invalid on
/// error. Native on purpose — it brings the platform's keyboard handling, typeahead and (on phones) its picker for free.
export function SelectField({ label, id, options, hint, error, hideLabel = false, className = "", ...rest }: SelectFieldProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div>
      <label htmlFor={selectId} className={hideLabel ? "sr-only" : "mb-1.5 block text-xs font-semibold tracking-wide text-fg-2 uppercase"}>
        {label}
      </label>
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`min-h-11 w-full appearance-none rounded-xl border bg-field py-3 pr-10 pl-4 text-sm text-fg transition-colors focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
            error
              ? "border-danger-icon/60 focus-visible:border-danger-icon focus-visible:ring-danger-icon/30"
              : "border-line hover:border-line-strong focus-visible:border-ring focus-visible:ring-ring/30"
          } ${className}`}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3.5 h-4 w-4 -translate-y-1/2 text-fg-muted" />
      </div>
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
