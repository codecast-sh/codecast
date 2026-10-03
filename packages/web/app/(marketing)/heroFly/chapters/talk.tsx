"use client";

/**
 * Chapter 5, Agents talk: the workers' transcripts as they message each other
 * with `cast send` (the real cast command block and "Message from" card, the
 * doc reference a real entity pill), then your steer on the API worker, the
 * turn that forks: the fork lifts off it as its inbox row, and the second
 * window opens on the fork, marked as a branch of the worker.
 */

import { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } from "@/components/conversation/ConversationHeaderBar";
import { ConversationMetadata } from "@/components/conversation/sessionChrome";
import { CastCommandBlock } from "@/components/conversation/blocks/castBlocks";
import { SessionMessageBlock } from "@/components/conversation/blocks/systemBlocks";
import { AssistantBlock, ForkSeedMark, UserPrompt } from "@/components/conversation/blocks/turnBlocks";
import { WORKERS } from "../fixtures/fanout";
import { REPLY as PHONE_REPLY, STEER } from "../fixtures/phone";
import { WorkerPlan, WorkerTask } from "./fanout";
import { FORK_ANSWER, FORK_CHILDREN, FORK_PROMPT, FORK_REPLAY, forkRow, MAIN_LINE, MESSAGE, REPLY, REPLY_RESULT, REPLY_SEND, SEND, SEND_RESULT } from "../fixtures/talk";
import { PEOPLE, SESSIONS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import { FilmGrow, FilmSwap, LiftedRow } from "../film";
import { TALK_AT } from "./talk.motion";
import type { PartProps } from "./contract";

const noop = () => {};
/**
 * A worker's window is narrower than the conversation the "Message from" card is
 * laid out for: its header keeps the sender's pill on one line and wraps the
 * link to the sending message under it, rather than breaking the session's name.
 */
const NARROW_CARDS = "[&_[data-cc-session-msg]>div:first-child]:flex-wrap [&_[data-cc-session-msg]_.entity-ref]:whitespace-nowrap";
const convLink = (id: string) => `/conversation/${id}`;
const FORKED = [TALK_AT.forked];

/** The API worker's side: its send, the reply that comes back, then your steer, which forks. */
export function ApiSide({ now }: PartProps) {
  // Each entry opens its own room as it lands (FilmGrow), so the transcript above it rises rather than jumping.
  return (
    <div className={`px-3 pb-1 ${NARROW_CARDS}`}>
      <FilmGrow at={TALK_AT.send}>
        <div {...fly("pairA/talk.send")}>
          <CastCommandBlock tool={SEND} result={SEND_RESULT} />
        </div>
      </FilmGrow>
      <FilmGrow at={TALK_AT.replyReceived}>
        <div {...fly("pairA/talk.reply")}>
          <SessionMessageBlock from={SESSIONS.ui.shortId} body={REPLY} timestamp={now - 2_000} />
        </div>
      </FilmGrow>
      <FilmGrow at={TALK_AT.prompt}>
        <div {...fly("pairA/talk.prompt")} className="pt-1">
          {/* The turn gains its branch strip as it forks: the forked turn dissolves in over the plain one as its height eases, so the transcript above rises. */}
          <FilmSwap
            cues={FORKED}
            render={(step) => (
              <UserPrompt
                content={FORK_PROMPT}
                timestamp={now - 5_000}
                messageId="hero-m-fork"
                messageUuid="hero-m-fork"
                userName={PEOPLE.me.name}
                avatarUrl={null}
                forkChildren={step ? FORK_CHILDREN : undefined}
                onBranchSwitch={noop}
                activeBranchId={null}
                mainDivergentPreview={MAIN_LINE}
              />
            )}
          />
        </div>
      </FilmGrow>
    </div>
  );
}

/** The dashboard worker's side: the message arrives, and it answers. */
export function UiSide({ now }: PartProps) {
  return (
    <div className={`px-3 pb-1 ${NARROW_CARDS}`}>
      <FilmGrow at={TALK_AT.received}>
        <div {...fly("pairB/talk.received")}>
          <SessionMessageBlock from={SESSIONS.api.shortId} body={MESSAGE} timestamp={now - 40_000} />
        </div>
      </FilmGrow>
      <FilmGrow at={TALK_AT.reply}>
        <div {...fly("pairB/talk.replySend")}>
          <CastCommandBlock tool={REPLY_SEND} result={REPLY_RESULT} />
        </div>
      </FilmGrow>
    </div>
  );
}

const forkOpen = (t: number) => t >= TALK_AT.forkVeil;

/** The second window opens on the fork: its header over the dashboard worker's. */
export function ForkHeader(_: PartProps) {
  if (!useFilmTime(forkOpen)) return null;
  return (
    <div {...fly("pairB/talk.forkHeadCover")} className="absolute inset-0 bg-sol-bg">
      <div {...fly("pairB/talk.forkHead")} className="h-full">
        <ConversationHeaderBar
          title={<ConversationHeaderTitle text={SESSIONS.fork.title} />}
          status={<AgentStatusPill agentStatus="working" />}
          facts={<ConversationMetadata agentType={SESSIONS.fork.agent} model={WORKERS.api.model} />}
        />
      </div>
    </div>
  );
}

/** The fork's transcript: where it branched from, the steer it took with it, and its first move. */
export function ForkFeed({ now }: PartProps) {
  if (!useFilmTime(forkOpen)) return null;
  return (
    <div {...fly("pairB/talk.forkCover")} className="absolute inset-0 bg-sol-bg">
      <div {...fly("pairB/talk.forkFeed")} className="absolute inset-0 flex flex-col justify-end px-3 pb-1">
        {/* A fork carries its parent's history up to the turn it branched at, so its window opens on the API worker's story, then the mark where it diverged. */}
        <WorkerTask which="api" now={now - 60_000} />
        <WorkerPlan which="api" now={now - 60_000} />
        <UserPrompt content={STEER} timestamp={now - 30_000} messageId="hero-m-fork-steer" userName={PEOPLE.me.name} avatarUrl={null} />
        <AssistantBlock content={PHONE_REPLY} timestamp={now - 25_000} messageId="hero-m-fork-reply" agentType={SESSIONS.api.agent} />
        <ForkSeedMark parentId={SESSIONS.api.id} parentTitle={SESSIONS.api.title} convLink={convLink} />
        <UserPrompt content={FORK_PROMPT} timestamp={now - 3_000} messageId="hero-m-fork-seed" userName={PEOPLE.me.name} avatarUrl={null} />
        <FilmGrow at={TALK_AT.forkAnswer}>
          <div {...fly("pairB/talk.forkAnswer")}>
            <AssistantBlock content={FORK_ANSWER} toolCalls={[FORK_REPLAY]} timestamp={now - 1_000} messageId="hero-m-fork-answer" agentType={SESSIONS.fork.agent} />
          </div>
        </FilmGrow>
      </div>
    </div>
  );
}

/** The flyers: each message in flight, as the card it lands as. */
export function EnvelopeFlyer({ now }: PartProps) {
  return (
    <div className={`w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-md bg-sol-bg p-1 shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45)] ${NARROW_CARDS}`}>
      <SessionMessageBlock from={SESSIONS.api.shortId} body={MESSAGE} timestamp={now - 1_000} />
    </div>
  );
}

export function EnvelopeBackFlyer({ now }: PartProps) {
  return (
    <div className={`w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-md bg-sol-bg p-1 shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45)] ${NARROW_CARDS}`}>
      <SessionMessageBlock from={SESSIONS.ui.shortId} body={REPLY} timestamp={now - 1_000} />
    </div>
  );
}

/** The fork in flight: the inbox row it becomes, lifted off the worker's turn toward its own window. */
export function ForkFlyer({ now }: PartProps) {
  return <LiftedRow session={forkRow(now)} now={now} />;
}
