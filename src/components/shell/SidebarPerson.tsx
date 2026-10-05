"use client";

import { ROLE_LABELS } from "@/lib/roles";
import { useShell } from "./ShellProvider";
import { initialsOf } from "./nav";

/// The signed-in person at the foot of the sidebar: their name and — in the school they are looking at — their role there.
export function SidebarPerson({ name, email }: { name: string | null; email: string | null }) {
  const { home } = useShell();
  const displayName = name?.trim() || email || "Signed in";

  return (
    <div role="group" aria-label="Signed in as" className="flex items-center gap-3 border-t border-line p-4">
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-strong text-xs font-bold text-white">
        {initialsOf(name, email)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-fg">{displayName}</p>
        <p className="truncate text-xs text-fg-muted">{home ? ROLE_LABELS[home.role] : name?.trim() && email ? email : "Signed in"}</p>
      </div>
    </div>
  );
}
