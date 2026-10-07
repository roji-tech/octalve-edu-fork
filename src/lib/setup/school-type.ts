import type { SchoolType } from "@prisma/client";

// Which kind of school a NEW school is (plan "Build design — Phase 1.2", decision P1). It comes from the server's environment, never from a client:
// the setup body is strict and has no such field, and a school's own administrator has no way to change it afterwards (it renames every term to
// semester or cohort). A platform superadmin screen will write the same column later.

export const SCHOOL_TYPES: readonly SchoolType[] = ["K12", "HIGHER_ED", "VOCATIONAL"];

/// `DEFAULT_SCHOOL_TYPE` from the environment: unset or blank → K12 (what every school that exists today is); anything else must be exactly one of the
/// three values, or this THROWS — a typo must stop the server with a message, not quietly make a K12 school out of a vocational one.
export function defaultSchoolType(env: Record<string, string | undefined> = process.env): SchoolType {
  const raw = env.DEFAULT_SCHOOL_TYPE?.trim();
  if (!raw) return "K12";
  const found = SCHOOL_TYPES.find((type) => type === raw);
  if (!found) throw new Error(`DEFAULT_SCHOOL_TYPE must be one of ${SCHOOL_TYPES.join(", ")} (got "${raw}")`);
  return found;
}
