import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { VerifiedTenantId } from "@/lib/tenant/verified-tenant";

// The tenant context (domain-implementation-plan.md §0.5.2, "`forTenant()` and `forUser()`").
//
//   authenticated user → verified tenant membership → set_config('app.tenant_id') → RLS
//
// ONE interactive transaction per request, with the context set first inside it, then the work. Three rules,
// each one learned from how this goes wrong:
//   1. `set_config(name, value, true)` — a bind parameter, never a string-built `SET LOCAL`. `SET` cannot take a
//      parameter, so anything that builds it by hand is an injection point in the very safety net;
//   2. the third argument is `true` (transaction-LOCAL). With `false` the tenant would stay on the pooled
//      connection and the next request to borrow it would run as that school;
//   3. the id is a `VerifiedTenantId`, so an unchecked string cannot be passed (see verified-tenant.ts).
// Row-level security policies read the setting back through `app_tenant_id()` (see the RLS migration).

export type Tx = Prisma.TransactionClient;

/// Interactive-transaction limits: waiting for a pooled connection, and the whole unit of work.
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/// Sets the tenant context for the rest of `tx`'s transaction. Exposed for code that must create a tenant and its
/// first rows atomically (the setup wizard); everything else uses `forTenant`.
export async function setTenantContext(tx: Tx, tenantId: VerifiedTenantId): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`;
}

/// Sets the *user* context — the second path of the membership policy: a person may read their own memberships
/// before any tenant is known. Read-only by construction (the policy has no user path for writes).
export async function setUserContext(tx: Tx, userId: string): Promise<void> {
  if (typeof userId !== "string" || userId.length === 0) throw new Error("setUserContext: no user id");
  await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}::text, true)`;
}

/// Sets the *invitation* context — the third read path, for the one moment a person has no membership: they hold an
/// invitation link. `tokenHash` is the SHA-256 (hex) of the token they presented, never the token. The policy on
/// `Invitation` lets this context read exactly the row whose hash matches and nothing else, and nothing is writable
/// through it: an accepting transaction reads the invitation here, then sets the TENANT context from the row it found
/// (`setTenantContext` with a `trustedTenantId` — the secret's hash named the tenant) before it writes anything.
export async function setInvitationContext(tx: Tx, tokenHash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("setInvitationContext: not a token hash");
  await tx.$queryRaw`SELECT set_config('app.invitation_hash', ${tokenHash}::text, true)`;
}

export function forTenant(tenantId: VerifiedTenantId) {
  return {
    /// Runs `fn` in one transaction with the tenant context set. Rolls back if `fn` throws.
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await setTenantContext(tx, tenantId);
        return fn(tx);
      }, TRANSACTION_OPTIONS);
    },
  };
}

export function forUser(userId: string) {
  return {
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await setUserContext(tx, userId);
        return fn(tx);
      }, TRANSACTION_OPTIONS);
    },
  };
}

export function forInvitation(tokenHash: string) {
  return {
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await setInvitationContext(tx, tokenHash);
        return fn(tx);
      }, TRANSACTION_OPTIONS);
    },
  };
}
