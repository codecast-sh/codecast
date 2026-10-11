// A stand-in for @pierre/diffs' React FileDiff, installed for every test file
// by preload.ts. The real one draws inside a shadow root once Shiki has loaded
// asynchronously, which never happens under jsdom or a static render, so a
// test of DiffView would see an empty host. This draws the rows DiffView
// derived (lib/diffMetadata) and the annotations it asked for, as plain light
// DOM, and keeps the props of every render so a test can read the options
// DiffView passed and call its handlers. What Pierre itself draws is checked
// in the browser.
import { createElement, type ReactNode } from "react";
import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions } from "@pierre/diffs/react";
import { diffRows } from "../lib/diffMetadata";

export type FileDiffProps = {
  fileDiff: FileDiffMetadata;
  options?: FileDiffOptions<any, any>;
  lineAnnotations?: DiffLineAnnotation<any>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<any>) => ReactNode;
  selectedLines?: unknown;
};

export const fileDiffRenders: FileDiffProps[] = [];

export function FileDiffStandIn(props: FileDiffProps) {
  fileDiffRenders.push(props);
  const { fileDiff, lineAnnotations = [], renderAnnotation } = props;
  const children: ReactNode[] = [];
  let previous: number | undefined;
  for (const row of diffRows(fileDiff)) {
    if (row.hidden) continue;
    const side = row.type === "removed" ? "deletions" : "additions";
    const lineNumber = (row.type === "removed" ? row.oldNum : row.newNum) ?? 0;
    if (previous !== undefined && lineNumber > previous + 1 && row.type !== "removed") {
      children.push(createElement("div", { key: `gap-${lineNumber}`, "data-separator": "" }, "⋯"));
    }
    if (row.type !== "removed") previous = lineNumber;
    children.push(
      createElement("div", {
        key: `${side}-${lineNumber}`,
        "data-line": lineNumber,
        "data-line-type": row.type === "added" ? "change-addition" : row.type === "removed" ? "change-deletion" : "context",
      }, row.content),
    );
    for (const annotation of lineAnnotations) {
      if (annotation.side === side && annotation.lineNumber === lineNumber && renderAnnotation) {
        children.push(createElement("div", { key: `note-${side}-${lineNumber}` }, renderAnnotation(annotation)));
      }
    }
  }
  return createElement("diffs-container", null, children);
}
