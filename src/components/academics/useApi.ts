"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, getJson, type Reply } from "@/components/auth/postJson";

export const failureText = (status: number, message?: string) =>
  status === 401
    ? SESSION_ENDED
    : status === 429
      ? RATE_LIMITED
      : status === 0
        ? NETWORK_ERROR
        : (message ?? "That didn't work. Please try again in a moment.");

/// Loads one URL and keeps the answer. `reload(true)` resolves when the new answer is IN THE DOM (so an action can wait for its own refresh
/// instead of guessing with a timer). `path = null` loads nothing.
export function useApi(path: string | null): {
  reply: Reply | null;
  error: string | null;
  loading: boolean;
  reload: (flush?: boolean) => Promise<void>;
} {
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal, flush = false) => {
      if (path === null) return;
      const answer = await getJson(path, signal);
      if (signal?.aborted) return;
      const apply = () => {
        if (answer.ok) {
          setReply(answer);
          setError(null);
        } else {
          setError(failureText(answer.status, answer.message));
        }
      };
      if (flush) flushSync(apply);
      else apply();
    },
    [path],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const reload = useCallback((flush = true) => load(undefined, flush), [load]);
  return { reply, error, loading: reply === null && error === null && path !== null, reload };
}

/// After a change that may have removed the control that had focus (an archived row, the closed dialog's opener): wait until the list has
/// been refreshed — and is in the DOM — and only then, if focus has fallen to <body>, park it on the section's summary line. No timer.
export function useAfterChange(reload: () => Promise<void>): {
  summaryRef: RefObject<HTMLParagraphElement | null>;
  afterChange: () => Promise<void>;
} {
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const afterChange = useCallback(async () => {
    await reload();
    if (!document.activeElement || document.activeElement === document.body) summaryRef.current?.focus();
  }, [reload]);
  return { summaryRef, afterChange };
}
