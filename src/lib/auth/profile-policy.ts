// The one rule for a person's display name (domain-implementation-plan.md §0.5.E), client-safe — the form's live
// feedback and the route both call it, like checkNewPassword(). Names are other people's too: Arabic, Yoruba,
// Igbo, hyphenated and multi-part names must all work, so the rule is about SAFETY, not about shape.

export const NAME_MAX_LENGTH = 100;

/// Control characters and the bidirectional-override characters (which can make a name display as something else
/// in a list). Zero-width joiners are NOT refused: Persian, Arabic and Indic scripts and many emoji need them.
const FORBIDDEN = /[\p{Cc}‪-‮⁦-⁩]/u;

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

/// Normalises (NFC, inner whitespace collapsed, trimmed) and checks. `name` in the result is what gets stored.
export function checkName(input: string): NameCheck {
  const name = input.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, message: "Enter your name." };
  if ([...name].length > NAME_MAX_LENGTH) {
    return { ok: false, message: `Use at most ${NAME_MAX_LENGTH} characters.` };
  }
  if (FORBIDDEN.test(name)) return { ok: false, message: "That name contains characters that can't be used." };
  return { ok: true, name };
}
