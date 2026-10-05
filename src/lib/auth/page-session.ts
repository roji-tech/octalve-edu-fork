import { cache } from "react";
import { redirect } from "next/navigation";
import { getUserMemberships } from "./memberships";
import { getSession } from "./session";

/// The session guard for PAGES (the API's is `withAuth`). Not signed in → /login. Wrapped in React's `cache`, so the
/// layout that draws the shell and the page inside it ask in the same request and the database is hit once.
/// **Every page must call this (or `requireTenantPage`) itself**: a layout does not re-render on a client-side
/// navigation between the pages it wraps, so the layout only DISPLAYS who is signed in — it is never the guard.
///
/// The memberships feed the shell's navigation (which schools exist for this person, and their role in each). That is
/// display data: what a school page or API lets someone do is decided there, from the membership, on every request.
export const requirePageSession = cache(async () => {
  const session = await getSession();
  if (!session) redirect("/login");
  const memberships = await getUserMemberships(session.userId);
  return { session, memberships };
});
