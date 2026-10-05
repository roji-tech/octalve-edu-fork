"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShell } from "./ShellProvider";
import { SoonTag } from "./SoonTag";
import { isActive, navFor } from "./nav";

/// The desktop sidebar's navigation. The current page is marked with `aria-current="page"` (which is also what the
/// styling keys off, so what sighted and screen-reader users are told can't drift apart); pages that don't exist yet
/// are plain text with a "Soon" tag.
export function SidebarNav() {
  const pathname = usePathname();
  const { home } = useShell();

  return (
    <nav aria-label="Main">
      <ul className="space-y-1">
        {navFor(home).map((item) => (
          <li key={item.label}>
            {item.href ? (
              <Link
                href={item.href}
                aria-current={isActive(pathname, item) ? "page" : undefined}
                className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-fg"
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            ) : (
              <span className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-fg-muted">
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
                <SoonTag />
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
