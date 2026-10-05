"use client";

import { useEffect, useState } from "react";

/// Reads the one-time token from the URL FRAGMENT (`#token=…`) of the page the emailed link opened, and removes it
/// from the address bar. The browser never sends a fragment to a server, so the secret is not in access logs or a
/// Referer; removing it keeps it out of history and screenshots too.
///
/// `token`: `undefined` = not read yet (server render, first paint); `""` = the URL carried no token. It also
/// listens for `hashchange`: opening a link in a tab that is already on this page changes only the fragment, which
/// does not reload the page, so without this the page would carry on with whatever it was showing. `version` goes
/// up with every link read (even the same link again): callers `key` their state on it, so each link starts from a
/// clean slate.
export function useFragmentToken(): { token: string | undefined; version: number } {
  const [state, setState] = useState<{ token: string | undefined; version: number }>({ token: undefined, version: 0 });

  useEffect(() => {
    function take(): string {
      const found = /[#&]token=([^&]+)/.exec(window.location.hash)?.[1] ?? "";
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return found;
    }
    const first = take();
    // Deferred a tick: React forbids setState synchronously inside an effect body.
    const timer = setTimeout(() => setState({ token: first, version: 1 }), 0);
    // Only a NEW token replaces the current one (removing the fragment above must not blank the page).
    const onHashChange = () => {
      const found = take();
      if (found) setState((current) => ({ token: found, version: current.version + 1 }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  return state;
}
