"use client";
// /share/call/<token>: a call's record (huddle or recording) as a stranger
// holding its link reads it: the recap, the action items, the audio when
// there is any, and the words, in the same turns the calls page draws. A link
// to a place in the call (?turns=, ?part=, @codecast/shared callLinks) lands
// there, marked, the way the call page does.
import type { FunctionReturnType } from "convex/server";
import { Mic } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { callAnchorKey, parseCallAnchor } from "@codecast/shared/contracts";
import { formatDateFull } from "@codecast/shared/time";
import { TranscriptTurnList } from "../../../../components/calls/TranscriptTurns";
import { groupTurns, oneSegmentTurns } from "../../../../components/calls/transcriptTurnModel";
import { fmtCallLength, speakerColor, firstName } from "../../../../components/calls/speakers";
import { MarkdownRenderer } from "../../../../components/tools/MarkdownRenderer";
import { SharedObjectPage } from "../../SharedObjectPage";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";

type SharedCall = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedCall>>;

const MARK = "ring-1 ring-inset ring-sol-violet/40 bg-sol-violet/10 rounded-md";

export default function SharedCallPage() {
  const anchor = parseCallAnchor(useSearchParams());
  const anchorKey = anchor ? callAnchorKey(anchor) : null;
  // Scroll the anchored place into view once it has rendered.
  useWatchEffect(() => {
    if (!anchorKey) return;
    const timer = setInterval(() => {
      const el = document.querySelector(`[data-call-anchor="${anchorKey}"], [data-call-anchor-turn]`);
      if (!el) return;
      clearInterval(timer);
      el.scrollIntoView({ block: "center" });
    }, 100);
    return () => clearInterval(timer);
  }, [anchorKey]);
  return (
    <SharedObjectPage<SharedCall> kind="call" query={api.publicShare.getSharedCall} noun="call">
      {(call) => {
        // A recording has one microphone: line by line, no speaker names.
        const turns = call.recording ? oneSegmentTurns(call.segments) : groupTurns(call.segments);
        const inAnchor = (i: number) =>
          anchor?.kind === "turns" &&
          turns[i]?.segments.some((sg) => sg.seq >= anchor.from_seq && sg.seq <= anchor.to_seq);
        const firstAnchored = turns.findIndex((_, i) => inAnchor(i));
        return (
          <>
            <div className="mb-8">
              <div className="flex items-center gap-2 mb-3 text-xs text-sol-text-dim">
                {call.recording && <Mic className="w-3.5 h-3.5" />}
                <span>{call.recording ? "Recording" : "Huddle"}</span>
                <span>{formatDateFull(call.started_at)}</span>
                <span>{fmtCallLength(call.started_at, call.ended_at)}</span>
              </div>
              <h1 className="text-2xl font-semibold text-sol-text mb-3">
                {call.title || (call.recording ? "Untitled recording" : "Untitled huddle")}
              </h1>
              {!call.recording && call.participants.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {call.participants.map((p) => (
                    <span key={p.id} className={`rounded-md bg-sol-base02/60 px-1.5 py-0.5 font-mono text-[11px] ${speakerColor(p.id)}`}>
                      {firstName(p.name)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {call.summary && (
              <div
                data-call-anchor="summary"
                className={`mb-6 px-4 py-3 border-l-2 border-sol-cyan/40 bg-sol-base02/50 rounded-r ${anchor?.kind === "summary" ? MARK : ""}`}
              >
                <div className="text-xs text-sol-text-dim uppercase tracking-wider mb-1">Summary</div>
                <div className="prose prose-invert prose-sm max-w-none">
                  <MarkdownRenderer content={call.summary} />
                </div>
              </div>
            )}

            {call.action_items.length > 0 && (
              <div className="mb-8">
                <div className="text-xs text-sol-text-dim uppercase tracking-wider mb-2">Action items</div>
                <ul className="space-y-1">
                  {call.action_items.map((a, i) => (
                    <li
                      key={i}
                      data-call-anchor={`action-${i}`}
                      className={`text-sm text-sol-text-muted flex gap-2 ${anchor?.kind === "action" && anchor.index === i ? `${MARK} px-1` : ""}`}
                    >
                      <span className="text-sol-cyan shrink-0">-</span>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {call.recording_url && (
              <audio controls preload="metadata" src={call.recording_url} className="w-full mb-8" />
            )}

            {turns.length > 0 && (
              <div className="border-t border-sol-border/20 pt-8">
                <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-4">Transcript</h2>
                <div className="space-y-2" data-call-anchor={anchor?.kind === "turns" ? anchorKey ?? undefined : undefined}>
                  <TranscriptTurnList turns={turns} compact={call.recording} isSelected={inAnchor} />
                </div>
              </div>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
