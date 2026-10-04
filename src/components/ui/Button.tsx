import type { ButtonHTMLAttributes, Ref } from "react";
import { SpinnerIcon } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  // White text must stay >= 4.5:1 in EVERY state, so the fill is the brand's *strong* token
  // (not its lighter accent) and hover/active darken instead of lightening.
  primary:
    "bg-brand-strong text-white shadow-lg shadow-brand-strong/25 hover:bg-brand-strong-hover active:bg-brand-strong-hover disabled:bg-surface-2 disabled:text-fg-muted disabled:shadow-none",
  secondary:
    "border border-line-strong bg-surface text-fg hover:bg-surface-2 disabled:text-fg-muted",
  ghost: "text-fg-2 hover:bg-surface-2 hover:text-fg disabled:text-fg-muted",
  danger:
    "border border-danger-line bg-danger-bg text-danger-fg hover:border-danger-icon disabled:text-fg-muted",
};

export function Button({
  variant = "primary",
  loading = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && <SpinnerIcon className="h-4 w-4 motion-safe:animate-spin" />}
      {children}
    </button>
  );
}
