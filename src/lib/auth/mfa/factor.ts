import { normaliseRecoveryCode, normaliseTotpCode } from "./codes";
import { type SecondFactor } from "./service";

/// A request body's second factor, or null if it isn't one: exactly ONE of `code` / `recoveryCode`, and the
/// one given must be shaped like what it claims to be. null means a typo, not a guess — routes answer 400
/// and hand back the rate-limit slot they reserved, so mistyping never counts against the person.
export function parseSecondFactor(input: { code?: string; recoveryCode?: string }): SecondFactor | null {
  const { code, recoveryCode } = input;
  if ((code === undefined) === (recoveryCode === undefined)) return null;
  if (code !== undefined) return normaliseTotpCode(code) !== null ? { code } : null;
  return normaliseRecoveryCode(recoveryCode ?? "") !== null ? { recoveryCode: recoveryCode ?? "" } : null;
}
