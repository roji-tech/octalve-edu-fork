"use client";

import { usePathname } from "next/navigation";
import { brand } from "@/lib/brand";
import { useShell } from "./ShellProvider";
import { pageLabel } from "./nav";

/// "Riverside Academy / Users" — where you are, in the top bar. The first crumb is the school the path is in (or the
/// product, on a page outside any school); the second is the page. `aria-current="page"` marks the last crumb.
export function Breadcrumb() {
  const pathname = usePathname();
  const { school } = useShell();
  const page = pageLabel(pathname);

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-2 text-sm">
        <li className="max-w-72 truncate text-fg-muted">{school?.name ?? brand.name}</li>
        {page && (
          <>
            <li aria-hidden="true" className="text-fg-muted">
              /
            </li>
            <li aria-current="page" className="font-semibold whitespace-nowrap text-fg">
              {page}
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}
