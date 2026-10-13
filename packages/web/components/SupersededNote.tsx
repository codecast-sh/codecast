// The one line a superseded artifact shows on its own page and in a history
// list (docs/architecture/line-versions.md LV3): that it was replaced, why in
// a few words, and a link to what replaced it.
import Link from "next/link";
import { SUPERSEDED_WORDS, type Superseded } from "@codecast/shared/contracts/superseded";
import { cn } from "../lib/utils";

/** Where the replacing thing opens: a problem, a trial card, or a run (by its id). */
function hrefOf(by: string): { href: string; label: string } | null {
  if (/^ct-\d+$/.test(by)) return { href: `/tasks/${by}`, label: by };
  if (/^tc-\d+$/.test(by)) return { href: `/trial?card=${by}`, label: by };
  if (/^[a-z0-9]{20,}$/.test(by)) return { href: `/workflows/runs/${by}`, label: "newer run" };
  return null;
}

export function SupersededNote({ superseded, className }: { superseded: NonNullable<Superseded>; className?: string }) {
  const to = superseded.by ? hrefOf(superseded.by) : null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sol-text-dim", className)} data-superseded={superseded.why}>
      <span>Replaced · {SUPERSEDED_WORDS[superseded.why]}</span>
      {to ? <Link href={to.href} className="text-sol-blue hover:underline" data-superseded-by={superseded.by}>{to.label}</Link> : superseded.by && <span data-superseded-by={superseded.by}>{superseded.by}</span>}
    </span>
  );
}
