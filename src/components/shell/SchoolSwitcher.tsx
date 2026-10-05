"use client";

import Link from "next/link";
import { ChevronDownIcon, GraduationCapIcon } from "@/components/ui/icons";
import { ROLE_LABELS } from "@/lib/roles";
import { useShell } from "./ShellProvider";
import { useDisclosure } from "./useDisclosure";
import { FOCUS_RING } from "./nav";

const LABEL = "text-[11px] font-semibold tracking-wider text-fg-muted uppercase";

/// Under the brand in the sidebar: which school you are in, and — with two or more — a way to change. One school is
/// plain text (nothing to switch to); none draws nothing. The entries are links to `/schools/<code>` for the person's
/// OWN schools; opening one runs the same membership check as any other visit, so this grants nothing.
export function SchoolSwitcher() {
  const { schools, school, home } = useShell();
  const { open, toggle, panelId, buttonRef, rootProps } = useDisclosure();
  const current = school ?? home;

  if (schools.length === 0) return null;

  if (schools.length === 1) {
    return (
      <div className="px-5 pb-3">
        <p className={LABEL}>School</p>
        <p className="mt-1 truncate text-sm font-semibold text-fg">{schools[0].name}</p>
      </div>
    );
  }

  return (
    <div {...rootProps} className="relative px-3 pb-3">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        className={`flex min-h-12 w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3 text-left transition-colors hover:border-line-strong ${FOCUS_RING}`}
      >
        <GraduationCapIcon className="h-4 w-4 shrink-0 text-brand-fg" />
        <span className="min-w-0 flex-1">
          <span className={`block ${LABEL}`}>School</span>
          <span className="block truncate text-sm font-semibold text-fg">{current?.name ?? "Choose a school"}</span>
        </span>
        <ChevronDownIcon className={`h-4 w-4 shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <ul id={panelId} className="absolute inset-x-3 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-menu">
          {schools.map((s) => (
            <li key={s.code}>
              <Link
                href={`/schools/${s.code}`}
                aria-current={s.code === school?.code ? "true" : undefined}
                className={`flex min-h-12 flex-col justify-center rounded-xl px-3 py-1.5 transition-colors hover:bg-surface-2 aria-[current=true]:bg-brand-tint ${FOCUS_RING}`}
              >
                <span className="truncate text-sm font-semibold text-fg">{s.name}</span>
                <span className="text-xs text-fg-muted">{ROLE_LABELS[s.role]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
