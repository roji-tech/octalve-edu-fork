"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { Reply } from "@/components/auth/postJson";
import { failureText } from "./useApi";
import type { PageMeta } from "./model";

/// One dialog's open state. The dialog component stays MOUNTED after it closes (so the platform hands focus back to the control that opened it) and
/// is remounted — fresh form, no old error — by the next `show` (its `n` is part of the component's key). Render it as
/// `{d.n > 0 && <X key={`d-${d.n}`} open={d.open} … />}`. The key needs a NAME as well as `n`: every dialog's `n` starts at 1, so two dialogs
/// keyed by `n` alone collide as siblings, and React then mounts a second copy while leaving the first (open) one in the page.
export function useDialog<T = true>() {
  const [state, setState] = useState<{ value: T | null; open: boolean; n: number }>({ value: null, open: false, n: 0 });
  return {
    value: state.value,
    open: state.open,
    n: state.n,
    show: (value: T) => setState((current) => ({ value, open: true, n: current.n + 1 })),
    hide: () => setState((current) => ({ ...current, open: false })),
  };
}

export type Notice = { variant: "success" | "error"; text: string } | null;

/// The one polite live region of a panel: a success is announced without interrupting; an error is an alert of its own.
export function LiveNotice({ notice }: { notice: Notice }) {
  return (
    <>
      <div role="status" aria-live="polite" className="empty:hidden">
        {notice && notice.variant === "success" && (
          <Alert variant="success" announce={false}>
            {notice.text}
          </Alert>
        )}
      </div>
      {notice && notice.variant === "error" && <Alert variant="error">{notice.text}</Alert>}
    </>
  );
}

export function StatusPill({ tone, children }: { tone: "ok" | "warn" | "neutral" | "info"; children: ReactNode }) {
  const style = {
    ok: "bg-ok-bg text-ok-fg",
    warn: "bg-warn-bg text-warn-fg",
    info: "bg-info-bg text-info-fg",
    neutral: "bg-surface-2 text-fg-2",
  }[tone];
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${style}`}>{children}</span>;
}

/// Loading / failed / empty, in the one shape every list uses.
export function ListState({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyText: ReactNode;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (error)
    return (
      <Alert variant="error" className="mt-3">
        <p>{error}</p>
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </Alert>
    );
  if (loading)
    return (
      <p className="mt-3 rounded-2xl border border-line bg-surface p-6 text-sm text-fg-muted" aria-busy="true">
        Loading…
      </p>
    );
  if (empty)
    return (
      <div className="mt-3 rounded-2xl border border-dashed border-line-strong p-8 text-center text-sm text-fg-muted">{emptyText}</div>
    );
  return <>{children}</>;
}

export function Pager({ meta, label, onPage }: { meta: PageMeta | null; label: string; onPage: (page: number) => void }) {
  if (!meta || meta.pages <= 1) return null;
  return (
    <nav aria-label={label} className="mt-4 flex items-center justify-between gap-3">
      <Button variant="secondary" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        Previous
      </Button>
      <p className="text-sm text-fg-muted">
        Page {meta.page} of {meta.pages}
      </p>
      <Button variant="secondary" disabled={!meta.hasNext} onClick={() => onPage(meta.page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/// What a form's submit returns: the server's answer, or the problems found before anything was sent (`field → message`).
export type Outcome = Reply | { errors: Record<string, string> };

/// A modal form. It owns what every form here shares — pending state, the Cancel/Save row, and turning a refusal into words next to the right
/// field (`body.name` → `errors.name`; `body.components.0` → `errors["components.0"]`). A refusal about something the form does not show (`fields`
/// lists what it does) appears once, above the buttons. The owner remounts it per opening (a `key`), so it always starts clean.
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  pendingLabel,
  fields,
  onSubmit,
  onDone,
  children,
  extraActions,
  submitDisabled = false,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  /// The keys the form shows an error for (`name`, `components` …); `components` covers `components.0.maxScore` too.
  fields: string[];
  onSubmit: () => Promise<Outcome>;
  onDone: (reply: Reply) => void;
  children: (errors: Record<string, string>, pending: boolean) => ReactNode;
  extraActions?: ReactNode;
  submitDisabled?: boolean;
  wide?: boolean;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    setPending(true);
    const outcome = await onSubmit();
    setPending(false);
    if ("errors" in outcome) {
      setErrors(outcome.errors);
      return;
    }
    if (outcome.ok) return onDone(outcome);
    const mapped: Record<string, string> = {};
    let unplaced = false;
    for (const detail of outcome.details ?? []) {
      const key = detail.path.replace(/^body\./, "");
      if (fields.some((field) => key === field || key.startsWith(`${field}.`))) mapped[key] ??= detail.message;
      else unplaced = true;
    }
    setErrors(mapped);
    if (Object.keys(mapped).length === 0 || unplaced) setFormError(failureText(outcome.status, outcome.message));
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} wide={wide}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {children(errors, pending)}
        {formError && <Alert variant="error">{formError}</Alert>}
        <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {extraActions}
          <Button type="submit" loading={pending} disabled={submitDisabled}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/// A confirmation that says what will happen and what will NOT (nothing is deleted anywhere here), with Cancel focused first.
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  pendingLabel,
  danger = false,
  onConfirm,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<Reply>;
  onDone: (reply: Reply) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    const reply = await onConfirm();
    setPending(false);
    if (reply.ok) return onDone(reply);
    setError(failureText(reply.status, reply.message));
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="text-sm leading-relaxed text-fg-2">{children}</div>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending} data-initial-focus>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={confirm} loading={pending}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
