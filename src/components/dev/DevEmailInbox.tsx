"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeftIcon, MailIcon, SpinnerIcon, TrashIcon, XIcon } from "@/components/ui/icons";

// The dev email inbox (domain-implementation-plan.md §0.5.F): a launcher bottom-right (the left edge is where an app shell's sidebar and Next's own dev indicator live) and a small dialog listing
// what the server's `inbox` email transport "sent". Mounted by the root layout ONLY where the dev tools are on
// (lib/dev-tools.ts) — never in production. It is clearly marked DEV so nobody mistakes it for product UI.
//
// Message bodies are rendered as TEXT, never as HTML (a message can contain anything, including markup meant
// to attack whoever reads it), and every http(s) URL in a body is also offered as a real link — a reset link is
// one click.

type DevEmail = { id: string; to: string; subject: string; text: string; sentAt: string };
type State = "loading" | "ready" | "locked" | "wrong-token" | "limited" | "off" | "error";

const POLL_MS = 4000;
const TOKEN_KEY = "dev-tools-token";
const SEEN_KEY = "dev-tools-seen";
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/// Which messages this tab has already read — kept for the tab's lifetime, so the badge doesn't reset on
/// every page navigation (the widget remounts with each full page load).
function readSeen(): ReadonlySet<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function writeSeen(ids: string[]) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(0, 100)));
  } catch {
    // best effort
  }
}

/// Only genuine http(s) URLs become links (a `javascript:` URL can't match the pattern, and is re-checked).
function linksIn(text: string): string[] {
  const found = new Set<string>();
  for (const candidate of text.match(URL_PATTERN) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") found.add(candidate);
    } catch {
      // not a URL after all
    }
  }
  return [...found];
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const iconButton =
  "inline-flex h-11 w-11 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:text-fg-muted";

export function DevEmailInbox() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>("loading");
  const [emails, setEmails] = useState<DevEmail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(readSeen);
  const [token, setToken] = useState(readToken);
  const [tokenDraft, setTokenDraft] = useState("");
  const launcherRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/dev/email-inbox", {
        headers: token ? { "x-dev-tools-token": token } : {},
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 404) return setState("off");
      if (res.status === 429) return setState("limited");
      if (res.status === 401) return setState(token ? "wrong-token" : "locked");
      if (!res.ok) return setState("error");
      const body = await res.json();
      setEmails(body.data.emails as DevEmail[]);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [token]);

  // One fetch on mount / when the token changes, then live refresh for as long as it works (4 s). It stops on
  // anything but "ready" — a locked or switched-off inbox is not polled.
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);
  useEffect(() => {
    if (state !== "ready") return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [state, load]);

  // Opening a message moves focus to its Back button (the row that was clicked is gone); going back moves it to the
  // dialog heading — focus is never left on an element that no longer exists.
  useEffect(() => {
    if (selectedId) backRef.current?.focus();
  }, [selectedId]);

  // Escape closes it from wherever focus is (including the page behind, if focus was lost).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Move focus into the dialog when it opens (its heading), and back to the launcher when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) headingRef.current?.focus();
    else if (wasOpen.current) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  /// Closing the dialog counts everything that was in it as read (while it is open the badge shows nothing).
  function close() {
    const ids = emails.map((e) => e.id);
    setSeen(new Set(ids));
    writeSeen(ids);
    setOpen(false);
  }

  async function clearAll() {
    try {
      await fetch("/api/v1/dev/email-inbox", {
        method: "DELETE",
        headers: token ? { "x-dev-tools-token": token } : {},
        credentials: "same-origin",
      });
    } finally {
      setSelectedId(null);
      void load();
    }
  }

  function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = tokenDraft.trim();
    if (!value) return;
    try {
      sessionStorage.setItem(TOKEN_KEY, value);
    } catch {
      // best effort: the token then lives only in memory for this page
    }
    setTokenDraft("");
    setState("loading");
    setToken(value);
  }

  if (state === "off") return null; // the server says the dev tools are not available here

  const selected = emails.find((e) => e.id === selectedId) ?? null;
  const unread = open ? 0 : emails.filter((e) => !seen.has(e.id)).length;

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label="Dev email inbox"
          className="fixed right-4 bottom-36 z-50 flex max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg-2 shadow-card lg:bottom-20"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 py-1 pr-1 pl-4">
            <h2 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold text-fg focus:outline-none">
              Dev email inbox
              <span className="rounded border border-warn-line bg-warn-bg px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-warn-fg uppercase">
                Dev
              </span>
            </h2>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => void clearAll()}
                aria-label="Clear all messages"
                title="Clear all"
                className={iconButton}
                disabled={state !== "ready" || emails.length === 0}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
              <button type="button" onClick={close} aria-label="Close dev email inbox" title="Close" className={iconButton}>
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {state === "loading" && (
              <p role="status" className="flex items-center gap-2 p-4 text-sm text-fg-muted">
                <SpinnerIcon className="h-4 w-4 motion-safe:animate-spin" /> Loading…
              </p>
            )}

            {(state === "locked" || state === "wrong-token") && (
              <form onSubmit={submitToken} className="space-y-3 p-4">
                <p className="text-sm text-fg-muted">This is a staging deployment. Enter the dev tools token to read its mail.</p>
                <div>
                  <label htmlFor="dev-tools-token" className="mb-1.5 block text-xs font-semibold tracking-wide text-fg-2 uppercase">
                    Dev tools token
                  </label>
                  <input
                    id="dev-tools-token"
                    type="password"
                    autoComplete="off"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    aria-invalid={state === "wrong-token" ? true : undefined}
                    aria-describedby={state === "wrong-token" ? "dev-tools-token-error" : undefined}
                    className="w-full rounded-xl border border-line bg-field px-3 py-3 text-sm text-fg focus:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                  {state === "wrong-token" && (
                    <p id="dev-tools-token-error" role="alert" className="mt-1.5 text-xs font-medium text-danger-text">
                      That token isn&apos;t right.
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  className="inline-flex min-h-11 items-center rounded-xl bg-brand-strong px-4 text-sm font-semibold text-white hover:bg-brand-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Unlock
                </button>
              </form>
            )}

            {state === "limited" && (
              <p role="alert" className="p-4 text-sm text-danger-text">
                Too many wrong tokens. Try again in a few minutes.
              </p>
            )}
            {state === "error" && (
              <p role="alert" className="p-4 text-sm text-danger-text">
                Couldn&apos;t reach the server.
              </p>
            )}

            {state === "ready" &&
              !selected &&
              (emails.length === 0 ? (
                <p className="p-6 text-center text-sm text-fg-muted">
                  No messages yet. Anything the app emails — a password-reset link, a security notice — shows up here.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {emails.map((email) => (
                    <li key={email.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(email.id)}
                        className="flex min-h-11 w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      >
                        <span className="flex items-baseline justify-between gap-3 text-xs text-fg-muted">
                          <span className="min-w-0 truncate">{email.to}</span>
                          <span className="shrink-0 tabular-nums">{time(email.sentAt)}</span>
                        </span>
                        <span className="truncate text-sm font-semibold text-fg">{email.subject}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}

            {state === "ready" && selected && (
              <article className="p-4">
                <button
                  ref={backRef}
                  type="button"
                  onClick={() => {
                    headingRef.current?.focus();
                    setSelectedId(null);
                  }}
                  className="-ml-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ArrowLeftIcon className="h-4 w-4" /> Back to the list
                </button>
                <p className="text-xs text-fg-muted">
                  To {selected.to} · {time(selected.sentAt)}
                </p>
                <h3 className="mt-1 text-sm font-semibold text-fg">{selected.subject}</h3>
                <pre className="mt-3 rounded-lg border border-line bg-surface-2 p-3 font-sans text-xs leading-relaxed break-words whitespace-pre-wrap text-fg-2">
                  {selected.text}
                </pre>
                {linksIn(selected.text).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold tracking-wide text-fg-2 uppercase">Links in this message</p>
                    <ul className="mt-1 space-y-1">
                      {linksIn(selected.text).map((href) => (
                        <li key={href}>
                          <a
                            href={href}
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 max-w-full items-center rounded-md text-xs break-all text-brand-fg underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            {href}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      )}

      <button
        ref={launcherRef}
        type="button"
        onClick={() => {
          if (open) return close();
          setOpen(true);
          void load(); // refresh straight away rather than waiting for the next poll
        }}
        aria-expanded={open}
        aria-label={unread > 0 ? `Dev email inbox, ${unread} unread` : "Dev email inbox"}
        title="Dev email inbox"
        className="fixed right-4 bottom-20 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-surface text-fg shadow-card transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:bottom-6"
      >
        <MailIcon className="h-5 w-5" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-strong px-1 text-[11px] font-bold text-white"
          >
            {unread}
          </span>
        )}
      </button>
    </>
  );
}
