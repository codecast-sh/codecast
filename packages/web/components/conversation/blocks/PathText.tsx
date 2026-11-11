import { splitPath } from "../../../lib/middleTruncate";

/**
 * A path that keeps its file name when the row runs out of room: two spans in
 * one line, the directories shrinking to an ellipsis and the name never
 * shrinking (lib/middleTruncate). The cut is flexbox and text-overflow, so it
 * reads no layout. The whole path rides in the tooltip.
 */
export function PathText({ path, className = "" }: { path: string; className?: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span data-cc-path title={path} className={`inline-flex max-w-full min-w-0 align-bottom whitespace-nowrap ${className}`}>
      {dir && <span data-cc-path-dir className="min-w-0 overflow-hidden text-ellipsis">{dir}</span>}
      <span data-cc-path-base className="shrink-0">{base}</span>
    </span>
  );
}
