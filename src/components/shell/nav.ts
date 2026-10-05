import type { ComponentType, SVGProps } from "react";
import type { Role } from "@prisma/client";
import { HomeIcon, SlidersIcon, UsersIcon } from "@/components/ui/icons";
import { isValidTenantCode } from "@/lib/tenant/validate-code";

/// A school the signed-in person belongs to, as the shell needs it. Display data only (see lib/auth/page-session.ts).
export type ShellSchool = { code: string; name: string; role: Role };

export type NavItem = {
  label: string;
  /// null → not built yet: shown as visibly-disabled text with a "Soon" tag, never as a link
  /// (a link to nothing would be a lie).
  href: string | null;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /// Active only on exactly this path (an Overview link is a prefix of every other page in its school).
  exact?: boolean;
};

/// The single source of truth for navigation: the sidebar, the phone tab bar and the "More" sheet are all derived
/// from this, so they can't disagree. `school` is the school being looked at (or the person's only school, when they
/// are on a page outside one); without it the person has a school to choose first.
/// Hiding an entry is a courtesy: the page and the API behind it decide.
export function navFor(school: ShellSchool | null): NavItem[] {
  if (!school) return [{ label: "Your schools", href: "/dashboard", icon: HomeIcon, exact: true }];
  const items: NavItem[] = [{ label: "Overview", href: `/schools/${school.code}`, icon: HomeIcon, exact: true }];
  if (school.role === "ADMIN") {
    items.push({ label: "Users", href: `/schools/${school.code}/users`, icon: UsersIcon }, { label: "Settings", href: null, icon: SlidersIcon });
  }
  return items;
}

/// Which of the person's schools the path names, if any. **For display only** — which links to draw. A path naming a
/// school the person is not in matches nothing (and the page behind it answers 403 on its own); the code is matched
/// the way the resolver matches it (trimmed, lower-cased), so `/schools/ABC` and `/schools/abc` highlight the same.
export function schoolFromPath(pathname: string, schools: readonly ShellSchool[]): ShellSchool | null {
  const match = /^\/schools\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return null;
  let code: string;
  try {
    code = decodeURIComponent(match[1]).trim().toLowerCase();
  } catch {
    return null; // a malformed escape is not a school
  }
  if (!isValidTenantCode(code)) return null;
  return schools.find((school) => school.code === code) ?? null;
}

/// The page's own name for the breadcrumb ("School / Users"), by path.
const SCHOOL_PAGES: Record<string, string> = { "": "Overview", users: "Users", settings: "Settings" };
const GLOBAL_PAGES: Record<string, string> = { "/dashboard": "Your schools", "/account": "Account" };

export function pageLabel(pathname: string): string | null {
  const own = GLOBAL_PAGES[pathname.replace(/\/+$/, "") || "/"];
  if (own) return own;
  const match = /^\/schools\/[^/]+(?:\/([^/]+))?\/?$/.exec(pathname);
  return match ? (SCHOOL_PAGES[match[1] ?? ""] ?? null) : null;
}

export const isActive = (pathname: string, item: Pick<NavItem, "href" | "exact">): boolean => {
  if (!item.href) return false;
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === item.href || (!item.exact && path.startsWith(`${item.href}/`));
};

/// One focus style for every shell control: a solid 2px ring in the brand's light colour,
/// offset from the edge so it reads on any surface in either theme.
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/// "Amina Yusuf" → "AY"; "Amina" → "A"; with no name, the first word of the email's local part.
export function initialsOf(name: string | null, email: string | null): string {
  const words = (name?.trim() || email?.split("@")[0] || "?").split(/[\s._-]+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] ?? "?"];
  return picked
    .map((word) => Array.from(word)[0]) // Array.from: don't split a surrogate pair in half
    .join("")
    .toUpperCase();
}
