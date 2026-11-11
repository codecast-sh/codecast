import { useMemo } from "react";
import { Layers } from "lucide-react";
import { modernGroupHead } from "../../../lib/modernRow";
import { RowIcon } from "./ModernRow";
import { PathText } from "./PathText";
import type { ToolCall, ToolResult } from "../types";

/**
 * A folded run of tool calls in Modern, as the row every tool call is: a 16px
 * glyph, "Ran 3 commands" (or the one call's verb with its command or path in
 * mono), a quiet count at the right. These are the children of the receipt's
 * header (CondensedToolsGroup in turnBlocks), which owns the click and draws
 * the chevron from aria-expanded; opening it shows each call as its own row.
 * The lead wrapper is display: contents in Modern and carries the error tone.
 */
export function ModernReceiptWords({ calls, counted, resultFor }: {
  calls: readonly { name: string; input: string; id?: string }[];
  counted: string;
  resultFor: (tc: ToolCall) => ToolResult | undefined;
}) {
  const head = useMemo(
    () => modernGroupHead(calls, counted, (call) => (call as ToolCall).id ? resultFor(call as ToolCall) : undefined),
    [calls, counted, resultFor],
  );
  return (
    <span data-cc-row-lead data-cc-row-tone={head.failed && calls.length === 1 ? "error" : undefined}>
      {head.kind === "group" ? <Layers data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} /> : <RowIcon kind={head.kind} />}
      <span data-cc-row-verb>{head.verb}</span>
      {head.object && (
        <span data-cc-row-object className="font-mono">{head.path ? <PathText path={head.object} /> : head.object}</span>
      )}
      {head.meta && (
        <span data-cc-row-meta className={`max-w-[55%] overflow-hidden text-ellipsis ${head.failed ? "text-sol-red" : ""}`} title={head.failed ? head.meta : undefined}>
          {head.meta}
        </span>
      )}
    </span>
  );
}
