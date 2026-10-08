import Link from "next/link";
import { FOCUS_RING } from "@/components/shell/nav";
import { SECTIONS, type SectionKey } from "./model";

/// The two parts of People, as real links (the address says which one you are on, so reload and the back button work).
export function SectionNav({ schoolCode, current }: { schoolCode: string; current: SectionKey }) {
  return (
    <nav aria-label="People sections" className="mt-6 border-b border-line">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {SECTIONS.map((section) => {
          const active = section.key === current;
          return (
            <li key={section.key} className="shrink-0">
              <Link
                href={`/schools/${schoolCode}/people?section=${section.key}`}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center border-b-2 px-4 text-sm font-semibold transition-colors ${FOCUS_RING} ${
                  active ? "border-brand-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
