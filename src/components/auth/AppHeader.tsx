import { GraduationCapIcon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { brand } from "@/lib/brand";
import { SignOutButton } from "./SignOutButton";

/// Top bar for signed-in screens. (AlEemaan's full app shell — sidebar, top bar, phone tab
/// bar — is in domain-implementation-plan.md §0.5.A; Octalve Edu adopts it with §0.5.2,
/// when tenant routing gives it a /schools/[code]/… to wrap.)
export function AppHeader({ name, email }: { name: string | null; email: string | null }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-canvas/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white"
          >
            <GraduationCapIcon className="h-5 w-5" />
          </span>
          <span className="text-base font-bold tracking-tight text-fg">{brand.name}</span>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <div className="hidden min-w-0 text-right sm:block">
            {name && <p className="truncate text-sm font-medium text-fg">{name}</p>}
            {email && <p className="truncate text-xs text-fg-muted">{email}</p>}
          </div>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
