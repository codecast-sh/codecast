"use client";

// The conversation header's "what it ran": the shell calls in the loaded
// transcript that touched the world (pushed, deleted, installed, wrote to the
// network, or ran something risky), named on the chip in their risk's color.
// A session that did none of that shows no chip.
// It opens a grouped list; a row jumps to its call. Derived from the messages
// the view already holds (lib/whatItRan), nothing stored.
import React, { memo, useMemo, useState } from "react";
import { SquareTerminal, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { HEADER_CHIP } from "../../lib/headerChip";
import { RAN_GROUPS, whatItRan, type RanCall, type RanGroup, type RanRisk } from "../../lib/whatItRan";

const GROUP_LABEL: Record<RanGroup, string> = {
  push: "Pushed",
  delete: "Deleted",
  install: "Installed",
  network: "Network",
  other: "Other",
};
const GROUP_TOKEN: Record<RanGroup, string> = {
  push: "push",
  delete: "del",
  install: "install",
  network: "net",
  other: "risky",
};
const RISK_TEXT: Record<RanRisk, string> = {
  danger: "text-sol-red",
  caution: "text-sol-orange",
  normal: "text-sol-text-muted",
};
const RISK_DOT: Record<RanRisk, string> = {
  danger: "bg-sol-red",
  caution: "bg-sol-orange",
  normal: "bg-sol-text-dim/50",
};
const RISK_RANK: Record<RanRisk, number> = { normal: 0, caution: 1, danger: 2 };

type Msg = Parameters<typeof whatItRan>[0] extends readonly (infer M)[] | undefined ? M : never;

// A group can run to thousands of calls (polling reads); the newest show, the rest on request.
const GROUP_CAP = 150;
const firstLine = (command: string) => command.split("\n").find((l) => l.trim()) ?? command;
const lineCount = (command: string) => command.split("\n").filter((l) => l.trim()).length;

function worstOf(calls: readonly RanCall[]): RanRisk {
  let worst: RanRisk = "normal";
  for (const c of calls) if (RISK_RANK[c.risk] > RISK_RANK[worst]) worst = c.risk;
  return worst;
}

export const WhatItRanChip = memo(function WhatItRanChip({
  messages,
  hasMoreAbove,
  hasMoreBelow,
  isLoadingOlder,
  onLoadOlder,
  onJumpToEnd,
  onJump,
}: {
  messages: readonly Msg[];
  hasMoreAbove?: boolean;
  /** The view jumped into the middle: later messages are not loaded either. */
  hasMoreBelow?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** Jump to the newest messages, when the view jumped into the middle. */
  onJumpToEnd?: () => void;
  onJump: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<RanGroup>>(() => new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<RanGroup>>(() => new Set());
  const add = (set: ReadonlySet<RanGroup>, g: RanGroup) => new Set([...set, g]);
  const summary = whatItRan(messages);
  const partial = !!(hasMoreAbove || hasMoreBelow);
  const { byGroup, risky } = useMemo(() => {
    const groups = new Map<RanGroup, RanCall[]>();
    for (const call of summary.calls) {
      const list = groups.get(call.group);
      if (list) list.push(call);
      else groups.set(call.group, [call]);
    }
    // What the chip names: the calls in each group that are more than a read
    // (a plain fetch is listed, not flagged), and risky ones of no group.
    const flagged = new Map<RanGroup, RanCall[]>();
    for (const [g, calls] of groups) flagged.set(g, calls.filter((c) => c.risk !== "normal"));
    return { byGroup: groups, risky: (g: RanGroup) => flagged.get(g) ?? [] };
  }, [summary]);
  const notable = RAN_GROUPS.filter((g) => risky(g).length > 0);
  // Nothing flagged in the loaded part: no chip. It speaks for what is
  // loaded, and its "+" says when that is not the whole session.
  if (!notable.length) return null;
  // A flagged call that exited non-zero may still have done its part (a push
  // before a failing `&& gh pr create`), so it counts; when every flagged
  // call failed the chip goes quiet and says so.
  const flaggedCalls = notable.flatMap((g) => risky(g));
  const failedFlagged = flaggedCalls.filter((c) => c.failed).length;
  const allFailed = failedFlagged === flaggedCalls.length;
  // The colour comes from what ran cleanly when anything did.
  const worst = worstOf(flaggedCalls.some((c) => !c.failed) ? flaggedCalls.filter((c) => !c.failed) : flaggedCalls);
  const lead = notable.reduce((best, g) => (RISK_RANK[worstOf(risky(g))] > RISK_RANK[worstOf(risky(best))] ? g : best), notable[0]);
  const ran = summary.calls.filter((c) => !c.denied).length;
  const label = `${notable.map((g) => `${GROUP_TOKEN[g]} ${risky(g).length}`).join(", ")}${failedFlagged ? ` (${failedFlagged} of them failed)` : ""} of ${ran} shell ${ran === 1 ? "command" : "commands"} run${partial ? " in the loaded part of the session" : ""}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-what-it-ran={worst}
          aria-label={`What it ran: ${label}`}
          title={`What it ran: ${label}`}
          className={`${HEADER_CHIP} ${open ? "bg-sol-bg-alt text-sol-text" : ""} flex-shrink-0`}
        >
          {/* The header family's quiet ink; only the icon carries the risk
              color, and only the riskiest group is named (the list has the rest). */}
          <SquareTerminal className={`w-3 h-3 ${allFailed ? "" : RISK_TEXT[worst]}`} aria-hidden />
          <span data-ran-token={lead} className={`tabular-nums ${risky(lead).every((c) => c.failed) ? "line-through decoration-1" : ""}`}>
            {GROUP_TOKEN[lead]} {risky(lead).length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(30rem,calc(100vw-1.5rem))] p-0 overflow-hidden">
        <div className="max-h-[min(28rem,70vh)] overflow-y-auto py-1" data-what-it-ran-list>
          {RAN_GROUPS.filter((g) => byGroup.has(g)).map((g) => {
            const calls = byGroup.get(g)!;
            // Flagged calls show; plain ones fold under the group's header.
            // Past the cap only the newest of each show, the rest on request.
            const plain = calls.filter((c) => c.risk === "normal");
            const flagged = calls.length - plain.length;
            const groupOpen = openGroups.has(g);
            const flaggedCalls = calls.filter((c) => c.risk !== "normal");
            const all = showAll.has(g);
            const flaggedShown = new Set(flaggedCalls.length > GROUP_CAP && !all ? flaggedCalls.slice(-GROUP_CAP) : flaggedCalls);
            const plainShown = new Set(groupOpen ? (plain.length > GROUP_CAP && !all ? plain.slice(-GROUP_CAP) : plain) : []);
            const rows = calls.filter((c) => flaggedShown.has(c) || plainShown.has(c));
            // What "N earlier" opens: the older flagged calls, and the older
            // plain ones once the group is open.
            const earlier = flaggedCalls.length - flaggedShown.size + (groupOpen ? plain.length - plainShown.size : 0);
            return (
              <section key={g} data-ran-group={g} className="py-1">
                {(() => {
                  const head = "w-full flex items-center gap-1.5 px-3 py-1 text-mark uppercase tracking-wider font-semibold text-sol-text-dim";
                  const body = (
                    <>
                      {plain.length > 0 && <ChevronRight aria-hidden className={`w-3 h-3 transition-transform ${groupOpen ? "rotate-90" : ""}`} />}
                      <span className={flagged ? RISK_TEXT[worstOf(calls)] : ""}>{GROUP_LABEL[g]}</span>
                      <span className="tabular-nums font-normal normal-case tracking-normal">{flagged && plain.length ? `${flagged} flagged · ${plain.length} more` : calls.length}</span>
                    </>
                  );
                  return plain.length > 0
                    ? <button type="button" aria-expanded={groupOpen} onClick={() => setOpenGroups((set) => { const next = new Set(set); if (next.has(g)) next.delete(g); else next.add(g); return next; })} className={`${head} hover:text-sol-text`}>{body}</button>
                    : <div className={head}>{body}</div>;
                })()}
                {earlier > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll((set) => add(set, g))}
                    className="w-full px-3 py-[3px] text-left text-meta text-sol-text-dim hover:text-sol-text"
                  >
                    {earlier} earlier
                  </button>
                )}
                {rows.map((call) => (
                  <button
                    key={`${call.messageId}:${call.callId}`}
                    type="button"
                    data-ran-call={call.risk}
                    onClick={() => { setOpen(false); onJump(call.messageId); }}
                    title={call.command}
                    className="w-full flex items-center gap-2 px-3 py-[3px] text-left hover:bg-sol-bg-highlight"
                  >
                    <span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${RISK_DOT[call.risk]}`} />
                    <code className={`min-w-0 flex-1 truncate font-mono text-[12px] ${call.risk === "normal" ? "text-sol-text-secondary" : RISK_TEXT[call.risk]}`}>
                      {firstLine(call.command)}
                    </code>
                    {lineCount(call.command) > 1 && <span className="shrink-0 text-meta tabular-nums text-sol-text-dim">{lineCount(call.command)} lines</span>}
                    {(call.denied || call.failed) && <span className="shrink-0 text-meta text-sol-text-dim">{call.denied ? "denied" : "failed"}</span>}
                  </button>
                ))}
              </section>
            );
          })}
        </div>
        {partial && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-sol-border/50 text-meta text-sol-text-dim">
            <span className="flex-1">{hasMoreAbove && hasMoreBelow ? "Earlier and later messages not loaded" : hasMoreAbove ? "Earlier messages not loaded" : "Later messages not loaded"}</span>
            {hasMoreBelow && onJumpToEnd && (
              <button type="button" onClick={() => { setOpen(false); onJumpToEnd(); }} className="shrink-0 text-sol-cyan hover:underline underline-offset-2">
                Jump to latest
              </button>
            )}
            {hasMoreAbove && onLoadOlder && (
              <button
                type="button"
                disabled={isLoadingOlder}
                onClick={onLoadOlder}
                className="shrink-0 text-sol-cyan hover:underline underline-offset-2 disabled:opacity-60"
              >
                {isLoadingOlder ? "Loading" : "Load earlier"}
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
