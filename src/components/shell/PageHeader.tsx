import type { ReactNode } from "react";

/// Title + one-line description (+ actions on the right) at the top of a page inside the shell.
/// The `<h1>` is the page's one heading level-1; sections below use `<h2>`.
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-fg sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 text-sm leading-relaxed text-fg-muted sm:text-base">{description}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
