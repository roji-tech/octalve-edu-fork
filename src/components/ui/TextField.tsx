import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  id?: string;
  hint?: string;
  error?: string | null;
  /// Rendered inside the input's right edge (e.g. a show/hide button).
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

/// A labelled text input with the accessibility wiring done once, correctly:
/// a real <label htmlFor>, hint/error linked via aria-describedby, and
/// aria-invalid when there is an error. Callers pass `autoComplete`,
/// `inputMode` etc. straight through. The label is the artifact's small
/// uppercase style (CSS only — the accessible name is the plain text).
export function TextField({
  label,
  id,
  hint,
  error,
  trailing,
  className = "",
  ref,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div>
      <label
        htmlFor={inputId}
        className="mb-1.5 block text-xs font-semibold tracking-wide text-fg-2 uppercase"
      >
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`w-full rounded-xl border bg-field px-4 py-3 text-sm text-fg placeholder:text-fg-muted transition-colors focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
            error
              ? "border-danger-icon/60 focus-visible:border-danger-icon focus-visible:ring-danger-icon/30"
              : "border-line hover:border-line-strong focus-visible:border-ring focus-visible:ring-ring/30"
          } ${trailing ? "pr-12" : ""} ${className}`}
          {...rest}
        />
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
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
