"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { MonitorIcon } from "@/components/ui/icons";
import { GENERIC_ERROR, NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, sendJson } from "@/components/auth/postJson";
import { relativeTime } from "@/lib/relative-time";

// "Active sessions" card (plan §0.5.E): where this account is signed in, so a device the person doesn't
// recognise can be ended. The list is fetched in the browser (it changes whenever another device acts, so it is
// never baked into the page), and the times are worded relative to NOW, which only the browser knows.

type Device = { id: string; device: string; current: boolean; createdAt: string; lastUsedAt: string; keptSignedIn: boolean };
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; sessions: Device[] };

export function SessionsPanel() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/auth/sessions", { credentials: "same-origin", cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && Array.isArray(json?.data?.sessions)) return setLoad({ state: "ready", sessions: json.data.sessions });
      setLoad({ state: "error", message: res.status === 401 ? SESSION_ENDED : GENERIC_ERROR });
    } catch {
      setLoad({ state: "error", message: NETWORK_ERROR });
    }
  }, []);

  useEffect(() => {
    // Deferred a tick: React forbids setState synchronously inside an effect body.
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  function failure(status: number, code?: string) {
    setError(status === 429 ? RATE_LIMITED : status === 401 ? SESSION_ENDED : code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  async function revokeOne(device: Device) {
    if (busy) return;
    setBusy(device.id);
    setNotice(null);
    setError(null);
    const reply = await sendJson("/api/v1/auth/sessions/revoke", "POST", { sessionId: device.id });
    setBusy(null);
    // 404 means it is already gone (it expired, or was ended from another tab) — which is what was asked for.
    if (reply.ok || reply.code === "NOT_FOUND") {
      setLoad((prev) => (prev.state === "ready" ? { state: "ready", sessions: prev.sessions.filter((s) => s.id !== device.id) } : prev));
      setNotice(`Signed out of ${device.device}.`);
      heading.current?.focus(); // the button that had focus just disappeared
    } else failure(reply.status, reply.code);
  }

  async function revokeOthers() {
    if (busy) return;
    setBusy("all");
    setNotice(null);
    setError(null);
    const reply = await sendJson("/api/v1/auth/sessions/revoke-others", "POST");
    setBusy(null);
    if (reply.ok) {
      const count = typeof reply.data?.revoked === "number" ? reply.data.revoked : 0;
      setLoad((prev) => (prev.state === "ready" ? { state: "ready", sessions: prev.sessions.filter((s) => s.current) } : prev));
      setNotice(count === 0 ? "There were no other devices signed in." : `Signed out of ${count} other ${count === 1 ? "device" : "devices"}.`);
      heading.current?.focus();
    } else failure(reply.status, reply.code);
  }

  const others = load.state === "ready" ? load.sessions.filter((s) => !s.current) : [];

  return (
    <div className="mt-4 space-y-4">
      <h3 ref={heading} tabIndex={-1} className="sr-only focus:not-sr-only focus:text-base focus:font-semibold focus:text-fg focus:outline-none">
        Devices signed in to your account
      </h3>
      {notice && <Alert variant="success">{notice}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      {load.state === "loading" && (
        <p className="text-sm text-fg-muted" aria-busy="true">
          Loading your devices…
        </p>
      )}

      {load.state === "error" && (
        <div className="space-y-3">
          <Alert variant="error">{load.message}</Alert>
          <Button variant="secondary" onClick={() => { setLoad({ state: "loading" }); void refresh(); }}>
            Try again
          </Button>
        </div>
      )}

      {load.state === "ready" && (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Signed-in devices">
            {load.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4" data-testid="session-row" data-current={s.current || undefined}>
                <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-2">
                  <MonitorIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                    <span className="min-w-0 break-words">{s.device}</span>
                    {s.current && (
                      <span className="inline-flex items-center rounded-full border border-ok-line bg-ok-bg px-2.5 py-0.5 text-xs font-semibold text-ok-fg">
                        This device
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    Signed in <time dateTime={s.createdAt} title={new Date(s.createdAt).toLocaleString()}>{relativeTime(s.createdAt)}</time>
                    {" · "}
                    Active <time dateTime={s.lastUsedAt} title={new Date(s.lastUsedAt).toLocaleString()}>{relativeTime(s.lastUsedAt)}</time>
                    {s.keptSignedIn && " · Kept signed in"}
                  </p>
                </div>
                {!s.current && (
                  <Button
                    variant="secondary"
                    onClick={() => revokeOne(s)}
                    loading={busy === s.id}
                    disabled={busy !== null}
                    aria-label={`Sign out ${s.device}, signed in ${relativeTime(s.createdAt)}`}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {others.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="danger" onClick={revokeOthers} loading={busy === "all"} disabled={busy !== null}>
                Sign out of all other devices
              </Button>
              <p className="text-xs text-fg-muted">Anyone using them will have to sign in again.</p>
            </div>
          ) : (
            <p className="text-sm text-fg-muted">You&apos;re not signed in anywhere else.</p>
          )}
        </>
      )}
    </div>
  );
}
