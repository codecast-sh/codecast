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
import { TranscriptTurnList } from "../../../../components/calls/TranscriptTurns";
import { groupTurns, oneSegmentTurns } from "../../../../components/calls/transcriptTurnModel";
import { fmtCallLength } from "../../../../components/calls/speakers";
import { Bullets, Callout, Pill, Prose, Section, ShareHead, SharedObjectPage } from "../../SharedObjectPage";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";

type SharedCall = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedCall>>;

const MARK = "ring-2 ring-sol-violet/50 rounded-[14px]";

export default function SharedCallPage() {
  const anchor = parseCallAnchor(useSearchParams());
  const anchorKey = anchor ? callAnchorKey(anchor) : null;
  // Scroll the anchored place into view once it has rendered.
  useWatchEffect(() => {
    if (!anchorKey) return;
    const timer = setInterval(() => {
      // Turns mark their list with the first anchored turn; the recap parts
      // carry the key themselves.
      const host = document.querySelector<HTMLElement>(`[data-call-anchor="${anchorKey}"]`);
      const first = host?.dataset.firstTurn;
      const el = first ? document.querySelector(`[data-turn="${first}"]`) : host;
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
            <ShareHead
              badges={
                <>
                  <Pill tone={call.recording ? "red" : "green"}>
                    {call.recording ? <Mic size={11} /> : null}
                    {call.recording ? "Recording" : "Huddle"}
                  </Pill>
                  <Pill quiet>{fmtCallLength(call.started_at, call.ended_at)}</Pill>
                </>
              }
              title={call.title || (call.recording ? "Untitled recording" : "Untitled huddle")}
              at={call.started_at}
              meta={
                !call.recording && call.participants.length > 0 ? (
                  <span>with {call.participants.map((p) => p.name).join(", ")}</span>
                ) : null
              }
            />
            {call.summary && (
              <div data-call-anchor="summary" className={anchor?.kind === "summary" ? MARK : ""}>
                <Callout label="Summary">
                  <Prose content={call.summary} compact />
                </Callout>
              </div>
            )}
            {call.action_items.length > 0 && (
              <Section title="Action items" count={call.action_items.length}>
                <Bullets
                  tone="cyan"
                  items={call.action_items.map((a, i) => (
                    <span key={i} data-call-anchor={`action-${i}`} className={anchor?.kind === "action" && anchor.index === i ? `${MARK} px-1` : ""}>
                      {a}
                    </span>
                  ))}
                />
              </Section>
            )}
            {call.recording_url && (
              <audio controls preload="metadata" src={call.recording_url} style={{ width: "100%", marginBottom: 36 }} />
            )}
            {turns.length > 0 && (
              <Section title="Transcript" count={turns.length}>
                <div
                  className="space-y-2"
                  data-call-anchor={firstAnchored >= 0 ? anchorKey ?? undefined : undefined}
                  data-first-turn={firstAnchored >= 0 ? turns[firstAnchored].index : undefined}
                >
                  <TranscriptTurnList turns={turns} compact={call.recording} isSelected={inAnchor} />
                </div>
              </Section>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
