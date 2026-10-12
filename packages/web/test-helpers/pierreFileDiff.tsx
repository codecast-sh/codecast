// A stand-in for @pierre/diffs' React FileDiff, installed for every test file
// by preload.ts. The real one draws inside a shadow root once Shiki has loaded
// asynchronously, which never happens under jsdom or a static render, so a
// test of DiffView would see an empty host. This draws the lines of the
// metadata it is given and the annotations DiffView asked for, as plain light
// DOM, and keeps the props of every render so a test can read the options
// DiffView passed and call its handlers. What Pierre itself draws is checked
// in the browser.
import { createElement, type ReactNode } from "react";
import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions } from "@pierre/diffs/react";

export type FileDiffProps = {
  fileDiff: FileDiffMetadata;
  options?: FileDiffOptions<any, any>;
  lineAnnotations?: DiffLineAnnotation<any>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<any>) => ReactNode;
  selectedLines?: unknown;
};

export const fileDiffRenders: FileDiffProps[] = [];

type Line = { type: "added" | "removed" | "context"; content: string; lineNumber: number };

// The lines the metadata's hunks show, numbered the way Pierre numbers them.
function hunkLines(meta: FileDiffMetadata): Line[] {
  const out: Line[] = [];
  const text = (l: string | undefined) => (l ?? "").replace(/\r?\n$/, "");
  for (const hunk of meta.hunks) {
    const oldNum = (i: number) => hunk.deletionStart + i - hunk.deletionLineIndex;
    const newNum = (i: number) => hunk.additionStart + i - hunk.additionLineIndex;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let k = 0; k < block.lines; k++) out.push({ type: "context", content: text(meta.additionLines[block.additionLineIndex + k]), lineNumber: newNum(block.additionLineIndex + k) });
        continue;
      }
      for (let k = 0; k < block.deletions; k++) out.push({ type: "removed", content: text(meta.deletionLines[block.deletionLineIndex + k]), lineNumber: oldNum(block.deletionLineIndex + k) });
      for (let k = 0; k < block.additions; k++) out.push({ type: "added", content: text(meta.additionLines[block.additionLineIndex + k]), lineNumber: newNum(block.additionLineIndex + k) });
    }
  }
  return out;
}

export function FileDiffStandIn(props: FileDiffProps) {
  fileDiffRenders.push(props);
  const { fileDiff, lineAnnotations = [], renderAnnotation } = props;
  const children: ReactNode[] = [];
  let previous: number | undefined;
  for (const row of hunkLines(fileDiff)) {
    const side = row.type === "removed" ? "deletions" : "additions";
    const lineNumber = row.lineNumber;
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
