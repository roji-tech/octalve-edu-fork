// The branded tenant id (domain-implementation-plan.md §0.5.2, "The branded id and its constructors").
//
// A `VerifiedTenantId` is a tenant id that something has *proved* the current caller may act on. It is a plain
// string at runtime and a distinct type at compile time, so `forTenant(req.url.slice(…))` does not compile: the
// only way to obtain one is `trustedTenantId()`, and that is deliberately named to be noticed in review and
// confined by ESLint (eslint.config.mjs) to the files that have a reason to call it:
//   - `resolve-tenant.ts` — AFTER the membership check; everything request-driven comes through here;
//   - the first-run setup route — the tenant was minted a moment ago by that same transaction;
//   - `lib/auth/audit.ts` — the id was just read from the person's own membership rows.
// Tenant business code never imports this file: it receives a verified id from `withAuth(…, { tenant: true })`.

export type VerifiedTenantId = string & { readonly __brand: "VerifiedTenantId" };

/// Declares an id verified. Only call it where the proof is in the lines immediately above.
export function trustedTenantId(id: string): VerifiedTenantId {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new Error("trustedTenantId: refusing an empty or oversized id");
  }
  return id as VerifiedTenantId;
}
