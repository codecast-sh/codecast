"use client";

/**
 * Chapter 5, Agents talk: the workers' transcripts as they message each other
 * with `cast send` (the real cast command block and "Message from" card, the
 * doc reference a real entity pill), then the dashboard worker's prompt with
 * its fork.
 */

import { CastCommandBlock } from "@/components/conversation/blocks/castBlocks";
import { SessionMessageBlock } from "@/components/conversation/blocks/systemBlocks";
import { UserPrompt } from "@/components/conversation/blocks/turnBlocks";
import { FORK_CHILDREN, FORK_PROMPT, MAIN_LINE, MESSAGE, REPLY, REPLY_RESULT, REPLY_SEND, SEND, SEND_RESULT } from "../fixtures/talk";
import { PEOPLE, SESSIONS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import { TALK_AT } from "./talk.motion";
import type { PartProps } from "./contract";

const noop = () => {};

/** The API worker's side: its send, then the reply that comes back. */
export function ApiSide({ now }: PartProps) {
  const step = useFilmTime((t) => (t < TALK_AT.send ? 0 : t < TALK_AT.replyReceived ? 1 : 2));
  if (step === 0) return null;
  return (
    <div className="px-3 pb-1">
      <div {...fly("pairA/talk.send")}>
        <CastCommandBlock tool={SEND} result={SEND_RESULT} />
      </div>
      {step === 2 && (
        <div {...fly("pairA/talk.reply")}>
          <SessionMessageBlock from={SESSIONS.ui.shortId} body={REPLY} timestamp={now - 2_000} />
        </div>
      )}
    </div>
  );
}

/** The dashboard worker's side: the message arrives, it answers, and Ashot forks it. */
export function UiSide({ now }: PartProps) {
  const step = useFilmTime((t) => (t < TALK_AT.received ? 0 : t < TALK_AT.reply ? 1 : t < TALK_AT.prompt ? 2 : t < TALK_AT.forked ? 3 : 4));
  if (step === 0) return null;
  return (
    <div className="px-3 pb-1">
      <div {...fly("pairB/talk.received")}>
        <SessionMessageBlock from={SESSIONS.api.shortId} body={MESSAGE} timestamp={now - 40_000} />
      </div>
      {step >= 2 && (
        <div {...fly("pairB/talk.replySend")}>
          <CastCommandBlock tool={REPLY_SEND} result={REPLY_RESULT} />
        </div>
      )}
      {step >= 3 && (
        <div {...fly("pairB/talk.prompt")} className="pt-1">
          <UserPrompt
            content={FORK_PROMPT}
            timestamp={now - 5_000}
            messageId="hero-m-fork"
            messageUuid="hero-m-fork"
            userName={PEOPLE.me.name}
            avatarUrl={null}
            forkChildren={step === 4 ? FORK_CHILDREN : undefined}
            onBranchSwitch={noop}
            activeBranchId={null}
            mainDivergentPreview={MAIN_LINE}
          />
        </div>
      )}
    </div>
  );
}

/** The flyers: each message in flight, as the card it lands as. */
export function EnvelopeFlyer({ now }: PartProps) {
  return (
    <div className="w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-md bg-sol-bg p-1 shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45)]">
      <SessionMessageBlock from={SESSIONS.api.shortId} body={MESSAGE} timestamp={now - 1_000} />
    </div>
  );
}

export function EnvelopeBackFlyer({ now }: PartProps) {
  return (
    <div className="w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-md bg-sol-bg p-1 shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45)]">
      <SessionMessageBlock from={SESSIONS.ui.shortId} body={REPLY} timestamp={now - 1_000} />
    </div>
  );
}
