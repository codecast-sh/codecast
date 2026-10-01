"use client";
// /share/call/<token>: a call's record (huddle or recording) as a stranger
// holding its link reads it: the recap, the action items, the audio when
// there is any, and the words, in the same turns the calls page draws.
import type { FunctionReturnType } from "convex/server";
import { Mic } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull } from "@codecast/shared/time";
import { TranscriptTurnList } from "../../../../components/calls/TranscriptTurns";
import { groupTurns, oneSegmentTurns } from "../../../../components/calls/transcriptTurnModel";
import { fmtCallLength, speakerColor, firstName } from "../../../../components/calls/speakers";
import { MarkdownRenderer } from "../../../../components/tools/MarkdownRenderer";
import { SharedObjectPage } from "../../SharedObjectPage";

type SharedCall = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedCall>>;

export default function SharedCallPage() {
  return (
    <SharedObjectPage<SharedCall> kind="call" query={api.publicShare.getSharedCall} noun="call">
      {(call) => {
        // A recording has one microphone: line by line, no speaker names.
        const turns = call.recording ? oneSegmentTurns(call.segments) : groupTurns(call.segments);
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
              <div className="mb-6 px-4 py-3 border-l-2 border-sol-cyan/40 bg-sol-base02/50 rounded-r">
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
                    <li key={i} className="text-sm text-sol-text-muted flex gap-2">
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
                <div className="space-y-2">
                  <TranscriptTurnList turns={turns} compact={call.recording} />
                </div>
              </div>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
