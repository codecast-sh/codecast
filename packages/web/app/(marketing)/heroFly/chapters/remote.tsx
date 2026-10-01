"use client";

/**
 * Chapter 13, Anywhere: the API worker's row is opened from the inbox, and
 * the stage shows its conversation the way the app does: its header with the
 * tmux pane it runs in on the cloud host, and the `cast browser` call it made
 * there, open, with the page it drives. The row in the right rail carries the
 * host's chip, so laptop and cloud sessions read side by side.
 */

import { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } from "@/components/conversation/ConversationHeaderBar";
import { ConversationAgeFacts, ConversationMetadata } from "@/components/conversation/sessionChrome";
import { AssistantBlock } from "@/components/conversation/blocks/turnBlocks";
import { CastCommandBlock } from "@/components/conversation/blocks/castBlocks";
import { TmuxAttachPill } from "@/components/TmuxAttachPill";
import { fly, useFilmTime } from "../filmClock";
import { WORKERS } from "../fixtures/fanout";
import { AFTER, BEFORE, BROWSE, TMUX_PANE } from "../fixtures/remote";
import { CUES, SESSIONS } from "../fixtures/story";
import type { PartProps } from "./contract";

const opened = (t: number) => t >= CUES.remoteOpen;

/** The API worker's header, over the lead's, once its row is opened. */
export function WorkerHeader({ now }: PartProps) {
  if (!useFilmTime(opened)) return null;
  return (
    <div {...fly("desk/remote.head")} className="absolute inset-0 bg-sol-bg">
      <ConversationHeaderBar
        title={<ConversationHeaderTitle text={SESSIONS.api.title} />}
        status={<AgentStatusPill agentStatus="working" />}
        facts={<>
          <ConversationMetadata agentType={SESSIONS.api.agent} model={WORKERS.api.model} />
          <ConversationAgeFacts startedAt={now - 21 * 60_000} messageCount={31} />
        </>}
        actions={<TmuxAttachPill tmuxSession={TMUX_PANE} agentType={SESSIONS.api.agent} isLive />}
      />
    </div>
  );
}

/** Its transcript's tail: why it looks, the browser it opened on the cloud host, and what it saw. */
export function WorkerTail({ now }: PartProps) {
  if (!useFilmTime(opened)) return null;
  return (
    <div {...fly("desk/remote.feed")} className="absolute inset-0 flex flex-col justify-end bg-sol-bg pb-2">
      <div className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <AssistantBlock content={BEFORE} timestamp={now - 40_000} messageId="hero-m-remote-before" agentType={SESSIONS.api.agent} showHeader />
      </div>
      <div {...fly("desk/remote.browse")} className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <CastCommandBlock tool={BROWSE.tool} result={BROWSE.result} defaultExpanded />
      </div>
      <div {...fly("desk/remote.after")} className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <AssistantBlock content={AFTER} timestamp={now - 4_000} messageId="hero-m-remote-after" agentType={SESSIONS.api.agent} />
      </div>
    </div>
  );
}
