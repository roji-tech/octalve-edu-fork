/// `amina@school.example` → `a***@school.example`. Used in security notices, so the person can recognise an address
/// without the notice itself becoming a place the full address is spread around. Anything that isn't shaped like
/// an address comes back as `***`.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const first = [...local][0];
  return `${first}***${email.slice(at)}`;
}
