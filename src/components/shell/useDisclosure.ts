"use client";

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { usePathname } from "next/navigation";

/// The behaviour of a **disclosure** (a button that shows or hides a panel of ordinary links and buttons): not an ARIA
/// `menu`, so it needs no arrow-key roving and makes no promise it doesn't keep. Closes on Escape (focus back on the
/// button), on a click outside, when Tab moves focus out of it, and on navigation. Shared by the account menu and the
/// school switcher so the one subtle case below is written once.
export function useDisclosure() {
  const pathname = usePathname();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Navigating anywhere closes it. (Adjusting state during render is React's documented way to reset state when a
  // value changes, without an effect.)
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const rootProps = {
    ref: rootRef,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        buttonRef.current?.focus();
      }
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      // Tab carried focus to another control outside it. Only when the browser names that control: Safari doesn't
      // focus buttons on click, so a click on an item inside the panel arrives here with no `relatedTarget` and must
      // NOT close it before the click lands.
      const next = event.relatedTarget as Node | null;
      if (open && next && !rootRef.current?.contains(next)) setOpen(false);
    },
  };

  return { open, toggle: () => setOpen((value) => !value), panelId, buttonRef, rootProps };
}
