"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSignOut } from "@/components/auth/useSignOut";
import { Button } from "@/components/ui/Button";
import { GraduationCapIcon, LogOutIcon, MoreIcon, UserIcon, XIcon } from "@/components/ui/icons";
import { ROLE_LABELS } from "@/lib/roles";
import { useShell } from "./ShellProvider";
import { SoonTag } from "./SoonTag";
import { FOCUS_RING, initialsOf, isActive, navFor } from "./nav";

const TAB =
  "flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-medium text-fg-muted transition-colors hover:text-fg aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-fg";
const SHEET_ROW =
  "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg";

/// Phone navigation (below `lg`): a floating bottom tab bar in place of a hamburger drawer, and a "More" sheet for
/// everything that doesn't fit — switching school, pages that aren't built yet, Profile, and Sign out. The sheet is a
/// native modal `<dialog>`, so the focus trap, Escape, an inert page behind it and focus returning to "More" come from
/// the platform rather than hand-rolled code.
export function MobileNav({ name, email }: { name: string | null; email: string | null }) {
  const pathname = usePathname();
  const { schools, school, home } = useShell();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { signOut, pending, error } = useSignOut();

  const items = navFor(home);
  const tabs = items.filter((item) => item.href);
  const soon = items.filter((item) => !item.href);
  const displayName = name?.trim() || email || "Account";

  // Any navigation closes the sheet (closing an already-closed dialog is a no-op).
  useEffect(() => {
    dialogRef.current?.close();
  }, [pathname]);

  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-3 bottom-3 z-30 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <ul className="flex gap-1 rounded-2xl border border-line bg-surface p-1.5 shadow-menu">
          {tabs.map((item) => (
            <li key={item.label} className="flex-1">
              <Link href={item.href!} aria-current={isActive(pathname, item) ? "page" : undefined} className={`${TAB} ${FOCUS_RING}`}>
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              onClick={() => {
                dialogRef.current?.showModal();
                setSheetOpen(true);
              }}
              className={`${TAB} ${FOCUS_RING}`}
            >
              <MoreIcon className="h-5 w-5" />
              More
            </button>
          </li>
        </ul>
      </nav>

      {/* The <dialog> fills the screen (transparent), so a tap anywhere outside the sheet lands on the dialog itself and
          closes it. */}
      <dialog
        ref={dialogRef}
        aria-labelledby="more-sheet-title"
        onClose={() => setSheetOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-fg backdrop:bg-black/60 open:flex open:flex-col lg:hidden"
      >
        <div className="mt-auto max-h-[85dvh] overflow-y-auto rounded-t-3xl border border-b-0 border-line bg-surface px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-menu">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-strong text-sm font-bold text-white">
              {initialsOf(name, email)}
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="more-sheet-title" className="truncate text-base font-semibold text-fg">
                {displayName}
              </h2>
              {name?.trim() && email && <p className="truncate text-xs text-fg-muted">{email}</p>}
              {home && (
                <p className="mt-0.5 truncate text-xs font-medium text-brand-fg">
                  {ROLE_LABELS[home.role]} · {home.name}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg ${FOCUS_RING}`}
            >
              <XIcon className="h-5 w-5" />
              <span className="sr-only">Close</span>
            </button>
          </div>

          {schools.length > 1 && (
            <section aria-labelledby="switch-school-title" className="mt-3 border-t border-line pt-2">
              <h3 id="switch-school-title" className="px-3 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
                Your schools
              </h3>
              <ul>
                {schools.map((s) => (
                  <li key={s.code}>
                    <Link
                      href={`/schools/${s.code}`}
                      aria-current={s.code === school?.code ? "true" : undefined}
                      className={`${SHEET_ROW} aria-[current=true]:bg-brand-tint aria-[current=true]:text-brand-fg ${FOCUS_RING}`}
                    >
                      <GraduationCapIcon className="h-5 w-5 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate">{s.name}</span>
                        <span className="block text-xs font-normal text-fg-muted">{ROLE_LABELS[s.role]}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ul className="mt-3 border-t border-line pt-2">
            {soon.map(({ label, icon: Icon }) => (
              <li key={label}>
                <span className={`${SHEET_ROW} text-fg-muted hover:bg-transparent hover:text-fg-muted`}>
                  <Icon className="h-5 w-5" />
                  {label}
                  <SoonTag />
                </span>
              </li>
            ))}
            <li>
              <Link href="/account" className={`${SHEET_ROW} ${FOCUS_RING}`}>
                <UserIcon className="h-5 w-5" />
                Profile
              </Link>
            </li>
          </ul>

          <div className="mt-2 border-t border-line pt-3">
            <Button variant="secondary" className="w-full" loading={pending} onClick={signOut}>
              {!pending && <LogOutIcon className="h-4 w-4" />}
              Sign out
            </Button>
            {error && (
              <p role="alert" className="mt-2 text-center text-xs font-medium text-danger-text">
                {error}
              </p>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
