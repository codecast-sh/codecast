import type { CSSProperties } from "react";

export const FIELD_SIZING_SUPPORTED =
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");
export const FIELD_SIZING_STYLE: CSSProperties = FIELD_SIZING_SUPPORTED
  ? ({ fieldSizing: "content" } as CSSProperties)
  : {};

/**
 * The composer's column: the conversation's column, or the host's full width
 * when it sits inline in another surface. Rows that hang off the composer
 * (the deleted-session banner, the mention menu) share it.
 */
export function composerColumn({ inline, expanded }: { inline: boolean; expanded: boolean }) {
  const colWidth = inline ? "w-full" : expanded ? "conv-col" : "max-w-md";
  const colClass = inline ? colWidth : `px-2 sm:px-4 ${colWidth}`;
  return { colWidth, colClass };
}
