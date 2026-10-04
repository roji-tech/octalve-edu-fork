// The light/dark choice. It lives in a plain cookie so the SERVER can render the right
// theme on the very first paint (no flash, hydration always agrees) and so no inline
// <script> is needed — which is what lets the Content-Security-Policy forbid them.
// Not a secret and not authentication: SameSite=Lax, readable by script (the toggle sets it).

export const THEME_COOKIE = "theme";
export type Theme = "dark" | "light";

/// The design artifact's default is dark. Anything unrecognised is dark too.
export function parseTheme(value: string | undefined | null): Theme {
  return value === "light" ? "light" : "dark";
}

export const THEME_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
