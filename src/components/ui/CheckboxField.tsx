import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { CheckIcon } from "@/components/ui/icons";

export type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  label: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

/// A labelled checkbox: a real <input type="checkbox"> inside a real <label>, so the
/// accessible name, Space to toggle, form semantics and the whole row being clickable all
/// come from the platform.
///
/// The box you see is drawn, so it can carry the brand and pass WCAG 1.4.11 (non-text
/// contrast >= 3:1 against the page) in BOTH themes: an unchecked box has an `fg-muted`
/// outline, a checked one is filled with the light brand colour with a dark tick, and a
/// keyboard-focused one gets a solid 2 px ring. The real input sits invisibly over the box
/// and is 44 x 44 CSS px, so the touch target is comfortable while the drawn box stays a
/// tidy 20 px. (`forced-colors`: fills are dropped by the browser, so the tick switches to
/// the system text colour and stays visible inside the system-coloured outline.)
export function CheckboxField({ label, className = "", ref, ...rest }: CheckboxFieldProps) {
  return (
    <label
      className={`flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${className}`}
    >
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <input
          ref={ref}
          type="checkbox"
          className="peer absolute -top-3 -left-3 h-11 w-11 cursor-[inherit] appearance-none opacity-0"
          {...rest}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none h-5 w-5 rounded-md border border-fg-muted bg-field transition-colors peer-checked:border-brand-fg peer-checked:bg-brand-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring"
        />
        <CheckIcon className="pointer-events-none absolute h-3.5 w-3.5 text-canvas opacity-0 transition-opacity peer-checked:opacity-100 forced-colors:text-[CanvasText]" />
      </span>
      <span>{label}</span>
    </label>
  );
}
