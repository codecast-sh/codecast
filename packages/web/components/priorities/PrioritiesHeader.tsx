// /priorities' header bar (components/ui/page-header), held to the list's
// column: the glyph centred in a box as wide as the list's rank column (20px
// wide, 16px on the phone layout: components/priorities/PriorityBlock), the
// 8px gap after it putting the title on the list's text edge. The way back ("← Inbox"
// on any arrival from another page) sits with the actions on the right, so it
// never pushes the glyph and title off those edges.
import type { ReactNode } from "react";
import { Target } from "lucide-react";
import { BackControl } from "../nav/BackControl";
import { PageHeader } from "../ui/page-header";
import { LegendButton, Mark } from "../Mark";
import { cn } from "../../lib/utils";
import type { ListLayout } from "../../lib/priorityList";

/** The header bar's first row held to the list's column (PrioritiesPage LIST_COLUMN). */
const HEAD_IN_COLUMN = "[&>div:first-child]:mx-auto [&>div:first-child]:w-full [&>div:first-child]:max-w-[1280px]";

export function PrioritiesHeader({ legacy, count, status, layout }: { legacy: ReactNode; count: number | null; status?: ReactNode; layout: ListLayout }) {
  return (
    <PageHeader
      legacy={legacy}
      title="Priorities"
      back={false}
      crumbs={null}
      glyph={<span data-priorities-glyph className={cn("flex justify-center", layout === "phone" ? "w-4" : "w-5")}><Mark id="entity.priority" labeled><Target className="size-4 shrink-0 text-sol-text-muted" aria-hidden /></Mark></span>}
      count={count}
      status={status}
      actions={<><BackControl /><LegendButton lead="Priorities" /></>}
      className={HEAD_IN_COLUMN}
    />
  );
}
