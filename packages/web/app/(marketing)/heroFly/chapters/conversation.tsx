"use client";

/**
 * Chapter 2, Steer: the lead's conversation pane, drawn by the app's own
 * header bar, message blocks and composer from ../fixtures/conversation.ts.
 * Before the lead takes the selection the pane shows the session that was
 * open; it cross-fades to the lead at `leadSelected`. The transcript is
 * anchored to the composer: each entry (chapter 3's spawns included) mounts
 * at its cue, opens its own measured room (FilmGrow) so the feed above it
 * rises, and drops in.
 */

import type { ReactNode } from "react";
import { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } from "@/components/conversation/ConversationHeaderBar";
import { ConversationAgeFacts, ConversationMetadata, WorkingStatusLineView } from "@/components/conversation/sessionChrome";
import { AssistantBlock, UserPrompt } from "@/components/conversation/blocks/turnBlocks";
import { ComposerSendButton, ComposerShell, ComposerTextarea, ComposerTextRow } from "@/components/ComposerShell";
import { ViewerFaces } from "@/components/presence/ViewerFaces";
import { typed } from "../timeline";
import { fly, useFilmTime } from "../filmClock";
import { FilmGrow, FilmSwap } from "../film";
import { DESK, leadMessages, STEER } from "../fixtures/desk";
import { ENTRIES, PREV, VIEWER, WORKING_CUES, WORKING_LABELS, type Entry } from "../fixtures/conversation";
import { CUES, PEOPLE, SESSIONS } from "../fixtures/story";
import { LEAD_TURN_ENDS } from "./conversation.motion";
import type { PartProps } from "./contract";

/** A transcript row, padded the way the conversation's feed pads its rows. */
function Row({ children }: { children: ReactNode }) {
  return <div className="conv-col mx-auto px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">{children}</div>;
}

function EntryView({ e, now, done }: { e: Entry; now: number; done: boolean }) {
  if (e.kind === "user") {
    return <UserPrompt content={e.text ?? ""} timestamp={now - e.ago} messageId={`hero-m-${e.key}`} userName={PEOPLE.me.name} avatarUrl={null} />;
  }
  return (
    <AssistantBlock
      content={e.text}
      thinking={e.thinking}
      showThinking={!!e.thinking}
      toolCalls={e.tool ? [e.tool] : undefined}
      toolResults={e.tool && e.result && (done || !e.pendingUntil) ? [e.result] : undefined}
      timestamp={now - e.ago}
      messageId={`hero-m-${e.key}`}
      agentType={e.agent}
      showHeader={!!e.header}
    />
  );
}

/** The header: the open session, then the lead with its status, model, age and who is looking. */
export function LeadHeader({ now }: PartProps) {
  const messages = useFilmTime(leadMessages);
  return (
    <div className="relative h-full bg-sol-bg">
      <div {...fly("desk/conversation.prevHead")} className="absolute inset-0">
        <ConversationHeaderBar
          title={<ConversationHeaderTitle text={PREV.title} />}
          status={<AgentStatusPill agentStatus="working" />}
          facts={<>
            <ConversationMetadata agentType={PREV.agent} model={PREV.model} />
            <ConversationAgeFacts startedAt={now - PREV.age} messageCount={PREV.messages} />
          </>}
        />
      </div>
      <div {...fly("desk/conversation.head")} className="absolute inset-0 bg-sol-bg">
        <ConversationHeaderBar
          title={<ConversationHeaderTitle text={SESSIONS.lead.title} />}
          // One status for the turn, the one the working line under the transcript shows: what it is doing goes in that line's label ("thinking", "editing retry.ts"), never a second status here.
          status={<AgentStatusPill agentStatus="working" />}
          facts={<>
            <ConversationMetadata agentType={SESSIONS.lead.agent} model={VIEWER.model} />
            <ConversationAgeFacts startedAt={now - 20_000} messageCount={messages} />
          </>}
          // Always laid out, so the header never reflows: the face fades in as Sarah starts watching (conversation.motion.ts).
          actions={<span {...fly("desk/conversation.viewer")} className="inline-flex"><ViewerFaces members={[VIEWER.sarah]} size={18} /></span>}
        />
      </div>
    </div>
  );
}

const TESTS_PASS = [CUES.testsPass];

/** The transcript: the open session's tail, then every entry of the lead's. */
export function LeadTranscript({ now }: PartProps) {
  const prevGone = useFilmTime((t) => t >= DESK.paneSwap + 0.6);
  return (
    <div className="relative shrink-0 bg-sol-bg">
      {!prevGone && (
        <div {...fly("desk/conversation.prev")} className="absolute inset-x-0 bottom-0 pb-2">
          {PREV.entries.map((e) => (
            <Row key={e.key}><EntryView e={e} now={now} done /></Row>
          ))}
        </div>
      )}
      <div {...fly("desk/conversation.feed")} className="pb-2">
        {ENTRIES.map((e) => (
          <FilmGrow key={e.key} at={e.cue} dur={0.7}>
            <div {...fly(`desk/conversation.entry:${e.key}`)} data-hero-live={e.live ? "" : undefined}>
              {/* A finished call gains its result's line count as the tests pass: dissolved in over the running one, never in one frame. */}
              <FilmSwap cues={TESTS_PASS} render={(step) => <Row><EntryView e={e} now={now} done={step > 0} /></Row>} />
            </div>
          </FilmGrow>
        ))}
      </div>
    </div>
  );
}

/** The composer: the working line follows the film, and the steer types itself in and sends. */
export function LeadComposer(_: PartProps) {
  const len = useFilmTime((t) => (t >= DESK.steerType && t < DESK.steerSent ? typed(STEER, t, DESK.steerType, DESK.steerRate).length : 0));
  // The film runs the turn about three times faster than life; the clock reads the turn's time. The turn ends once both workers are spawned.
  const working = useFilmTime((t) => (t >= CUES.prompt && t < LEAD_TURN_ENDS + 0.5 ? Math.floor((t - CUES.prompt) * 3) : 0));
  const draft = STEER.slice(0, len);
  const start = 1_000_000;
  return (
    <div className="h-full flex flex-col justify-end bg-sol-bg">
      <ComposerShell
        inline={false}
        // The working line keeps its room for the whole film and fades with the turn (conversation.motion.ts), so the composer never jumps.
        // Each new label fades out the old and in the new (FilmSwap through), so what it is doing never changes in one frame.
        // The app shows the clock and label only after 10s of work; the film's first state holds them back, so they arrive with the first crossing rather than in one frame.
        meta={<span {...fly("desk/conversation.working")} className="inline-flex"><FilmSwap cues={WORKING_CUES} ground="" through render={(step) => <WorkingStatusLineView startedAt={start} now={step === 0 ? start : start + working * 1000} label={WORKING_LABELS[step]} />} /></span>}
      >
        <ComposerTextRow send={<span {...fly("desk/conversation.send")} className="inline-flex"><ComposerSendButton canSubmit={draft.length > 0} /></span>}>
          <ComposerTextarea value={draft} readOnly placeholder="Send a message..." tabIndex={-1} />
        </ComposerTextRow>
      </ComposerShell>
    </div>
  );
}

