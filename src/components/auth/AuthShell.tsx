import type { ReactNode } from "react";
import { GraduationCapIcon, CheckIcon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { brand } from "@/lib/brand";

/// The design artifact's sign-in layout, shared by every signed-out screen (/login, /setup,
/// and later the reset and MFA screens): on large screens a 46 % brand panel (deep brand
/// colour, faint grid, headline, three points) beside the form; on small ones a compact
/// centred brand header above it. The panel is decorative (aria-hidden) — the form side is
/// the only landmark that matters to assistive tech. `size` picks the form column's width.
export function AuthShell({
  children,
  size = "sm",
}: {
  children: ReactNode;
  size?: "sm" | "md";
}) {
  return (
    <div className="min-h-screen bg-canvas text-fg lg:flex">
      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-brand-deep p-14 text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[46%] lg:shrink-0 lg:flex-col lg:justify-between lg:self-start"
      >
        <div className="brand-pattern pointer-events-none absolute inset-0" />

        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
            <GraduationCapIcon className="h-5 w-5" />
          </span>
          <span className="text-lg font-bold tracking-tight">{brand.name}</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-4xl leading-tight font-bold tracking-tight">{brand.login.headline}</h2>
          <p className="mt-4 text-base leading-relaxed text-white/80">{brand.login.blurb}</p>
          <ul className="mt-6 space-y-3">
            {brand.login.points.map((point) => (
              <li key={point} className="flex items-center gap-2.5 text-sm text-white/90">
                <CheckIcon className="h-4 w-4 shrink-0" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-white/60">
          © {new Date().getFullYear()} {brand.name}. All rights reserved.
        </div>
      </aside>

      <main className="flex min-h-screen flex-1 flex-col lg:min-h-0">
        <div className="flex justify-end px-4 pt-4 sm:px-8 sm:pt-6 lg:px-10">
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-4 pt-4 pb-14 sm:px-8">
          <div className={`w-full ${size === "md" ? "max-w-[30rem]" : "max-w-[24rem]"}`}>
            <div className="mb-8 flex flex-col items-center text-center lg:hidden">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-white"
              >
                <GraduationCapIcon className="h-5 w-5" />
              </span>
              <p className="mt-3 text-xl font-bold tracking-tight text-fg">{brand.name}</p>
              <p className="mt-1 text-sm text-fg-muted">{brand.tagline}</p>
            </div>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
