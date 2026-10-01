"use client";

/**
 * Chapter 2, Steer: the lead's conversation pane, drawn by the app's own
 * header bar, message blocks and composer from ../fixtures/conversation.ts.
 * Before the lead takes the selection the pane shows the session that was
 * open; it cross-fades to the lead at `leadSelected`. The transcript is
 * anchored to the composer: each entry (chapter 3's spawns included) mounts
 * at its cue and drops in, and the feed glides up by its height
 * (glideOver in ../fixtures/desk.ts).
 */

import type { ReactNode } from "react";
import { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } from "@/components/conversation/ConversationHeaderBar";
import { ConversationAgeFacts, ConversationMetadata, WorkingStatusLineView } from "@/components/conversation/sessionChrome";
import { AssistantBlock, UserPrompt } from "@/components/conversation/blocks/turnBlocks";
import { ComposerSendButton, ComposerShell, ComposerTextarea, ComposerTextRow } from "@/components/ComposerShell";
import { ViewerFaces } from "@/components/presence/ViewerFaces";
import { typed } from "../timeline";
import { fly, useFilmTime } from "../filmClock";
import { DESK, leadMessages, STEER } from "../fixtures/desk";
import { ENTRIES, PREV, SARAH_VIEWING, VIEWER, workingLabel, type Entry } from "../fixtures/conversation";
import { CUES, PEOPLE, SESSIONS } from "../fixtures/story";
import type { PartProps } from "./contract";
import { DeskRouter } from "./desk";

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
  const viewing = useFilmTime((t) => t >= SARAH_VIEWING);
  const status = useFilmTime((t) => (t >= DESK.thinking && t < DESK.edit ? "thinking" : "working"));
  return (
    <DeskRouter>
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
            status={<AgentStatusPill agentStatus={status} />}
            facts={<>
              <ConversationMetadata agentType={SESSIONS.lead.agent} model={VIEWER.model} />
              <ConversationAgeFacts startedAt={now - 20_000} messageCount={messages} />
            </>}
            actions={viewing ? <ViewerFaces members={[VIEWER.sarah]} size={18} /> : undefined}
          />
        </div>
      </div>
    </DeskRouter>
  );
}

/** The transcript: the open session's tail, then every entry of the lead's. */
export function LeadTranscript({ now }: PartProps) {
  const landed = useFilmTime((t) => ENTRIES.filter((e) => t >= e.cue).length);
  const testsDone = useFilmTime((t) => t >= CUES.testsPass);
  const prevGone = useFilmTime((t) => t >= DESK.paneSwap + 0.6);
  return (
    <DeskRouter>
      <div className="relative shrink-0 bg-sol-bg">
        {!prevGone && (
          <div {...fly("desk/conversation.prev")} className="absolute inset-x-0 bottom-0 pb-2">
            {PREV.entries.map((e) => (
              <Row key={e.key}><EntryView e={e} now={now} done /></Row>
            ))}
          </div>
        )}
        <div {...fly("desk/conversation.feed")} className="pb-2">
          {ENTRIES.slice(0, landed).map((e) => (
            <div key={e.key} {...fly(`desk/conversation.entry:${e.key}`)} data-hero-live={e.live ? "" : undefined}>
              <Row><EntryView e={e} now={now} done={testsDone} /></Row>
            </div>
          ))}
        </div>
      </div>
    </DeskRouter>
  );
}

/** The composer: the working line follows the film, and the steer types itself in and sends. */
export function LeadComposer(_: PartProps) {
  const len = useFilmTime((t) => (t >= DESK.steerType && t < DESK.steerSent ? typed(STEER, t, DESK.steerType, DESK.steerRate).length : 0));
  // The film runs the turn about three times faster than life; the clock reads the turn's time.
  const working = useFilmTime((t) => (t >= CUES.prompt ? Math.floor((t - CUES.prompt) * 3) : -1));
  const label = useFilmTime(workingLabel);
  const draft = STEER.slice(0, len);
  const start = 1_000_000;
  return (
    <div className="h-full flex flex-col justify-end bg-sol-bg">
      <ComposerShell
        inline={false}
        meta={working >= 0 ? <WorkingStatusLineView startedAt={start} now={start + working * 1000} label={label} /> : null}
      >
        <ComposerTextRow send={<span {...fly("desk/conversation.send")} className="inline-flex"><ComposerSendButton canSubmit={draft.length > 0} /></span>}>
          <ComposerTextarea value={draft} readOnly placeholder="Send a message..." tabIndex={-1} />
        </ComposerTextRow>
      </ComposerShell>
    </div>
  );
}

