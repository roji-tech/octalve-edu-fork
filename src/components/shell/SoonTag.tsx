/// "Soon" marker for navigation that isn't built yet. The visible pill is decorative; the
/// screen-reader text says the same thing in words, so the entry reads "Settings, coming soon".
export function SoonTag() {
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase"
      >
        Soon
      </span>
      <span className="sr-only">, coming soon</span>
    </>
  );
}
