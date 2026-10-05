"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { schoolFromPath, type ShellSchool } from "./nav";

type ShellState = {
  schools: readonly ShellSchool[];
  /// The school the path names (and the person belongs to), if any.
  school: ShellSchool | null;
  /// The school the navigation is drawn for: the one in the path, or — on a page outside any school, like the account
  /// page — the person's ONLY school, so the sidebar still leads somewhere. With several, they choose first.
  home: ShellSchool | null;
};

const Context = createContext<ShellState | null>(null);

/// The shell's one piece of client state: which school this page is in. Derived from the path and the person's own
/// memberships (passed down from the server layout); never from anything the page was asked for. Display only.
export function ShellProvider({ schools, children }: { schools: readonly ShellSchool[]; children: ReactNode }) {
  const pathname = usePathname();
  const value = useMemo<ShellState>(() => {
    const school = schoolFromPath(pathname, schools);
    return { schools, school, home: school ?? (schools.length === 1 ? schools[0] : null) };
  }, [pathname, schools]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useShell(): ShellState {
  const value = useContext(Context);
  if (!value) throw new Error("useShell must be used inside <ShellProvider>");
  return value;
}
