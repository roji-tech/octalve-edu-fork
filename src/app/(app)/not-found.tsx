import Link from "next/link";
import { AlertTriangleIcon } from "@/components/ui/icons";

// The 404 view for a page inside the signed-in shell (`notFound()` — e.g. a student or staff id that is not in this school).
// Written here rather than left to Next's built-in page: that one carries an inline <style>, which the strict CSP refuses.
// It names nothing about what was asked for, so "never existed" and "belongs to another school" look the same.
export default function NotFound() {
  return (
    <div>
      <div className="mx-auto max-w-xl py-10 text-center sm:py-16">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-fg-2">
          <AlertTriangleIcon className="h-7 w-7" />
        </span>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-fg">We couldn&apos;t find that page</h1>
        <p className="mt-2 text-base text-fg-muted">Check the address, or go back to your dashboard and start from there.</p>
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
