"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { broadcastSignOut } from "./authChannel";

/// The one sign-out routine, shared by every place that offers it (the top-bar button, the
/// profile menu, the phone "More" sheet): ask the server to end the session, tell the other
/// tabs, and go to /login. A failure is reported, never swallowed, and leaves the person signed
/// in — they must not believe they signed out of a shared computer when they didn't.
export function useSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error(`logout failed: ${res.status}`);
      broadcastSignOut();
      router.replace("/login");
      router.refresh();
    } catch {
      setPending(false);
      setError("Couldn't sign you out. Please try again.");
    }
  }

  return { signOut, pending, error };
}
