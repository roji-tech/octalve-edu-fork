import type { ReactNode } from "react";
import { SessionRevalidator } from "@/components/auth/SessionRevalidator";
import { GraduationCapIcon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { brand } from "@/lib/brand";
import { Breadcrumb } from "./Breadcrumb";
import { MobileNav } from "./MobileNav";
import { ProfileMenu } from "./ProfileMenu";
import { SchoolSwitcher } from "./SchoolSwitcher";
import { ShellProvider } from "./ShellProvider";
import { SidebarNav } from "./SidebarNav";
import { SidebarPerson } from "./SidebarPerson";
import type { ShellSchool } from "./nav";

export type ShellUser = { name: string | null; email: string | null };

function BrandMark({ size }: { size: "sm" | "md" }) {
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-xl bg-brand text-white ${size === "md" ? "h-10 w-10" : "h-9 w-9"}`}>
      <GraduationCapIcon className="h-5 w-5" />
    </span>
  );
}

/// The signed-in app's frame, from the design artifact ("same shell, one brand tweak" — ported from AlEemaan's):
///  - `lg` and up: a 248 px sidebar (brand, school, navigation, the signed-in person) and a 60 px top bar (breadcrumb,
///    theme toggle, account menu);
///  - below `lg`: a compact top bar and a floating bottom tab bar with a "More" sheet — the page reserves room for it,
///    so it never covers content.
/// Unlike AlEemaan's, this shell is **school-aware**: the navigation follows the school the path is in (see
/// `ShellProvider`). A skip link is the first thing in the tab order. Every page inside is still responsible for its own
/// session and school check; the shell only displays who is signed in and which schools they belong to.
export function AppShell({ user, schools, children }: { user: ShellUser; schools: readonly ShellSchool[]; children: ReactNode }) {
  return (
    <ShellProvider schools={schools}>
      <div className="min-h-screen bg-canvas text-fg-2">
        <SessionRevalidator />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand-strong focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>

        <div className="fixed inset-y-0 left-0 z-20 hidden w-62 flex-col border-r border-line bg-surface lg:flex">
          <div className="flex h-15 shrink-0 items-center gap-3 px-5">
            <BrandMark size="md" />
            <span className="text-lg font-bold tracking-tight text-fg">{brand.name}</span>
          </div>
          <SchoolSwitcher />
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <SidebarNav />
          </div>
          <SidebarPerson name={user.name} email={user.email} />
        </div>

        <div className="lg:pl-62">
          <header className="sticky top-0 z-20 flex h-15 items-center justify-between gap-4 border-b border-line bg-canvas px-4 sm:px-6">
            <div className="flex items-center gap-2.5 lg:hidden">
              <BrandMark size="sm" />
              <span className="text-base font-bold tracking-tight text-fg">{brand.name}</span>
            </div>
            <div className="hidden min-w-0 lg:block">
              <Breadcrumb />
            </div>

            <div className="flex items-center gap-2">
              <ThemeToggle />
              <ProfileMenu name={user.name} email={user.email} />
            </div>
          </header>

          {/* pb-32 on phones: the floating tab bar (~72 px + its 12 px gap + the safe area) must never cover the last
              thing on the page. */}
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-8 pb-32 focus:outline-none sm:px-6 lg:py-10 lg:pb-12">
            {children}
          </main>
        </div>

        <MobileNav name={user.name} email={user.email} />
      </div>
    </ShellProvider>
  );
}
