import Link from "next/link";
import { ShieldCheckIcon } from "@/components/ui/icons";

// The 403 view (rendered by `forbidden()` — lib/tenant/page-tenant.ts): signed in, but this school isn't yours.
// It deliberately names nothing: not the school, not whether it exists. "No such school" and "not a member of it"
// look exactly the same, so the page cannot be used to find out which schools exist.
export default function Forbidden() {
  return (
    <div>
      <div className="mx-auto max-w-xl py-10 text-center sm:py-16">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warn-bg text-warn-icon">
          <ShieldCheckIcon className="h-7 w-7" />
        </span>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-fg">You don&apos;t have access to this school</h1>
        <p className="mt-2 text-base text-fg-muted">
          Check the address, or ask your school administrator to invite you. If you belong to a school, you can reach it from your dashboard.
        </p>
        <Link
          href="/dashboard"
          className="mt-8 inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-strong px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-strong/25 transition-colors hover:bg-brand-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Go to your dashboard
        </Link>
      </div>
    </div>
  );
}
