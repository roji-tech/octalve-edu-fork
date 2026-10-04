"use client";

import { MoonIcon, SunIcon } from "./icons";
import { useTheme } from "./ThemeProvider";

/// Icon button that flips light/dark. Its accessible name says what will HAPPEN
/// ("Switch to light theme"), like the sign-in "Show password" toggle — the icon shows
/// the theme you would switch to (sun while dark), as in the design artifact.
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const toLight = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={toLight ? "Switch to light theme" : "Switch to dark theme"}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-field text-fg-2 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${className}`}
    >
      {toLight ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
    </button>
  );
}
