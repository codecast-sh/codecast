import type { DocType } from "@codecast/shared/docs";

// Styling only; the type list and labels come from @codecast/shared/docs.
// Typed by DocType so a type added there without a style here fails to compile.
const DOC_TYPE_STYLE: Record<DocType, { color: string; dot: string }> = {
  note: { color: "text-gray-400", dot: "bg-gray-400" },
  plan: { color: "text-sol-blue", dot: "bg-sol-blue" },
  design: { color: "text-sol-violet", dot: "bg-sol-violet" },
  spec: { color: "text-sol-cyan", dot: "bg-sol-cyan" },
  investigation: { color: "text-sol-yellow", dot: "bg-sol-yellow" },
  handoff: { color: "text-sol-orange", dot: "bg-sol-orange" },
  decision: { color: "text-sol-red", dot: "bg-sol-red" },
  charter: { color: "text-sol-magenta", dot: "bg-sol-magenta" },
  brief: { color: "text-sol-green", dot: "bg-sol-green" },
};
export const docTypeStyle = (docType: string) => DOC_TYPE_STYLE[docType as DocType] ?? DOC_TYPE_STYLE.note;
