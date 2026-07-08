// Pure patch parsing now lives in @codecast/convex so it can be shared with the
// server-side file-change materializer. This module re-exports it and keeps the
// web-only presentation helper (getFileStatus) local.
export { parsePatch } from "@codecast/convex/convex/fileChanges/patchParser";
export type { PatchHunk, PatchLine, ParsedPatch } from "@codecast/convex/convex/fileChanges/patchParser";

export function getFileStatus(status: string): {
  label: string;
  color: string;
  bgColor: string;
} {
  switch (status.toLowerCase()) {
    case "added":
      return { label: "A", color: "text-sol-green", bgColor: "bg-sol-green/20" };
    case "removed":
    case "deleted":
      return { label: "D", color: "text-sol-red", bgColor: "bg-sol-red/20" };
    case "modified":
      return { label: "M", color: "text-sol-yellow", bgColor: "bg-sol-yellow/20" };
    case "renamed":
      return { label: "R", color: "text-sol-cyan", bgColor: "bg-sol-cyan/20" };
    case "copied":
      return { label: "C", color: "text-sol-violet", bgColor: "bg-sol-violet/20" };
    default:
      return { label: "?", color: "text-sol-text-muted", bgColor: "bg-sol-text-muted/20" };
  }
}
