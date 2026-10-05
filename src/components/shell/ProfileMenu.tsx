"use client";

import Link from "next/link";
import { useSignOut } from "@/components/auth/useSignOut";
import { ChevronDownIcon, LogOutIcon, SlidersIcon, UserIcon } from "@/components/ui/icons";
import { ROLE_LABELS } from "@/lib/roles";
import { useShell } from "./ShellProvider";
import { SoonTag } from "./SoonTag";
import { useDisclosure } from "./useDisclosure";
import { FOCUS_RING, initialsOf } from "./nav";

const ITEM =
  "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg";

/// The top-bar account menu: avatar (+ name from `sm` up) opening Profile, Settings (soon, for an administrator of the
/// school in view) and Sign out. A disclosure (see `useDisclosure`), not an ARIA `menu`.
export function ProfileMenu({ name, email }: { name: string | null; email: string | null }) {
  const { open, toggle, panelId, buttonRef, rootProps } = useDisclosure();
  const { home } = useShell();
  const { signOut, pending, error } = useSignOut();
  const displayName = name?.trim() || email || "Account";

  return (
    <div {...rootProps} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        className={`flex h-11 items-center gap-2.5 rounded-xl px-1.5 text-left transition-colors hover:bg-surface-2 sm:pr-3 ${FOCUS_RING}`}
      >
        <span className="sr-only">Account menu for {displayName}</span>
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-strong text-xs font-bold text-white">
          {initialsOf(name, email)}
        </span>
        <span aria-hidden="true" className="hidden max-w-40 truncate text-sm font-medium text-fg sm:block">
          {displayName}
        </span>
        <ChevronDownIcon className={`hidden h-4 w-4 text-fg-muted transition-transform sm:block ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div id={panelId} className="absolute top-full right-0 z-30 mt-2 w-72 rounded-2xl border border-line bg-surface p-1.5 shadow-menu">
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-fg">{displayName}</p>
            {name?.trim() && email && <p className="truncate text-xs text-fg-muted">{email}</p>}
            {home && <p className="mt-1 text-xs font-medium text-brand-fg">{ROLE_LABELS[home.role]} · {home.name}</p>}
          </div>
          <div className="my-1 h-px bg-line" />

          <Link href="/account" className={`${ITEM} ${FOCUS_RING}`}>
            <UserIcon className="h-4 w-4" />
            Profile
          </Link>
          {home?.role === "ADMIN" && (
            <span className={`${ITEM} text-fg-muted hover:bg-transparent hover:text-fg-muted`}>
              <SlidersIcon className="h-4 w-4" />
              Settings
              <SoonTag />
            </span>
          )}

          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            onClick={signOut}
            disabled={pending}
            className={`${ITEM} disabled:cursor-wait disabled:opacity-60 ${FOCUS_RING}`}
          >
            <LogOutIcon className="h-4 w-4" />
            {pending ? "Signing out…" : "Sign out"}
          </button>
          {error && (
            <p role="alert" className="px-3 pb-2 text-xs font-medium text-danger-text">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
