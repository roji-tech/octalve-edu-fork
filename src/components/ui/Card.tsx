import type { HTMLAttributes } from "react";

/// The standard raised surface: cards on dashboards, the setup wizard, settings panels.
export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-7 ${className}`}
      {...rest}
    />
  );
}
