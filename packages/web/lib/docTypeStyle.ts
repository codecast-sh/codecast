import type { DocType } from "@codecast/shared/docs";

// Styling only; the type list and labels come from @codecast/shared/docs.
// Typed by DocType so a type added there without a style here fails to compile.
// Every surface that colors a doc by its type reads this map: the docs list
// and its rows, the doc page and its type picker, a project's docs, and the
// shared doc page. The classes are written out whole because Tailwind finds
// them by reading the source.
const DOC_TYPE_STYLE: Record<DocType, { color: string; dot: string; bg: string }> = {
  note: { color: "text-sol-text-muted", dot: "bg-sol-text-muted", bg: "bg-sol-text-muted/10 border-sol-text-muted/30" },
  plan: { color: "text-sol-blue", dot: "bg-sol-blue", bg: "bg-sol-blue/10 border-sol-blue/30" },
  design: { color: "text-sol-violet", dot: "bg-sol-violet", bg: "bg-sol-violet/10 border-sol-violet/30" },
  spec: { color: "text-sol-cyan", dot: "bg-sol-cyan", bg: "bg-sol-cyan/10 border-sol-cyan/30" },
  investigation: { color: "text-sol-yellow", dot: "bg-sol-yellow", bg: "bg-sol-yellow/10 border-sol-yellow/30" },
  handoff: { color: "text-sol-orange", dot: "bg-sol-orange", bg: "bg-sol-orange/10 border-sol-orange/30" },
  decision: { color: "text-sol-red", dot: "bg-sol-red", bg: "bg-sol-red/10 border-sol-red/30" },
  charter: { color: "text-sol-magenta", dot: "bg-sol-magenta", bg: "bg-sol-magenta/10 border-sol-magenta/30" },
  brief: { color: "text-sol-green", dot: "bg-sol-green", bg: "bg-sol-green/10 border-sol-green/30" },
};
export const docTypeStyle = (docType: string) => DOC_TYPE_STYLE[docType as DocType] ?? DOC_TYPE_STYLE.note;
