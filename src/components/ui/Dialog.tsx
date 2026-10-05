"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { XIcon } from "./icons";

/// A modal dialog on the native <dialog>: the platform supplies the focus trap, Escape, the inert page behind it, and — on close — focus
/// back on the control that opened it (initial focus: see the effect below). `open` is the one source of truth; Escape is reported through `onClose` so the owner's state follows.
/// It does NOT close on a click outside: these dialogs hold a form, and a stray tap must not throw away what someone typed.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // `autoFocus` does not fire in a dialog that opens after it mounted, and the platform's default is the first focusable thing — the
      // Close button. Focus the control the content marked (`data-initial-focus`, e.g. Cancel on a destructive confirmation) or else its
      // first form field, so a keyboard or screen-reader user lands where they will type.
      const target = dialog.querySelector<HTMLElement>("[data-initial-focus]") ?? dialog.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
      target?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-menu backdrop:bg-black/60"
    >
      {open && (
        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold tracking-tight text-fg">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-fg-muted">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mt-1 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <XIcon className="h-5 w-5" />
              <span className="sr-only">Close</span>
            </button>
          </div>
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
