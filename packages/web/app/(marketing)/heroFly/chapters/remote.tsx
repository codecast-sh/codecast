"use client";

/**
 * Chapter 13, Anywhere: the API worker's row is opened from the inbox, and
 * the stage shows its conversation the way the app does: its header with the
 * tmux pane it runs in on the cloud host, and the `cast browser` call it made
 * there, open, with the page it drives. The row in the right rail carries the
 * host's chip, so laptop and cloud sessions read side by side.
 */

import { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } from "@/components/conversation/ConversationHeaderBar";
import { ConversationMetadata } from "@/components/conversation/sessionChrome";
import { AssistantBlock } from "@/components/conversation/blocks/turnBlocks";
import { CastCommandBlock } from "@/components/conversation/blocks/castBlocks";
import { TmuxAttachPill } from "@/components/TmuxAttachPill";
import { SessionWorktreeChip } from "@/components/SessionWorktreeChip";
import { DeviceIcon, deviceDisplayName } from "@/components/DeviceBadge";
import { fly, useFilmTime } from "../filmClock";
import { CLOUD_HOST, CLOUD_WORKTREE } from "../fixtures/desk";
import { WORKERS } from "../fixtures/fanout";
import { AFTER, BEFORE, BROWSE, TESTS, TMUX_PANE } from "../fixtures/remote";
import { CUES, SESSIONS } from "../fixtures/story";
import type { PartProps } from "./contract";
import { REMOTE_CLEAR } from "./remote.motion";

/** The pane clears to the page's cream as the row is opened, then the worker's conversation fades in on it, so the two transcripts never print over each other. */
const opened = (t: number) => t >= CUES.remoteOpen - REMOTE_CLEAR;
/**
 * Where the worker runs: the cloud host's mark and its worktree, the chip its
 * inbox row carries. (The app's header names a worktree through WorktreePill,
 * which reads the repo's worktrees from the server, so the sandbox shows the
 * row's chip in its place.)
 */
const HOST_CHIP = (
  <SessionWorktreeChip
    name={CLOUD_WORKTREE.name}
    branch={CLOUD_WORKTREE.branch}
    hostName={deviceDisplayName(CLOUD_HOST)}
    hostIcon={<DeviceIcon d={CLOUD_HOST} className="w-2.5 h-2.5 shrink-0" />}
  />
);

/** The API worker's header, over the lead's, once its row is opened. Its facts are the agent, the model and the host chip, so the chip that proves the cloud host reads whole. */
export function WorkerHeader(_: PartProps) {
  if (!useFilmTime(opened)) return null;
  return (
    <div {...fly("desk/remote.headCover")} className="absolute inset-0 bg-sol-bg">
      <div {...fly("desk/remote.head")} className="h-full">
      <ConversationHeaderBar
        title={<ConversationHeaderTitle text={SESSIONS.api.title} />}
        status={<AgentStatusPill agentStatus="working" />}
        facts={<>
          <ConversationMetadata agentType={SESSIONS.api.agent} model={WORKERS.api.model} />
          {HOST_CHIP}
        </>}
        actions={<TmuxAttachPill tmuxSession={TMUX_PANE} agentType={SESSIONS.api.agent} isLive />}
      />
      </div>
    </div>
  );
}

/** Its transcript's tail: why it looks, the browser it opened on the cloud host, and what it saw. */
export function WorkerTail({ now }: PartProps) {
  if (!useFilmTime(opened)) return null;
  return (
    <div {...fly("desk/remote.cover")} className="absolute inset-0 bg-sol-bg">
    <div {...fly("desk/remote.feed")} className="absolute inset-0 flex flex-col justify-end pb-2">
      <div className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <AssistantBlock toolCalls={[TESTS.tool]} toolResults={[TESTS.result]} timestamp={now - 70_000} messageId="hero-m-remote-tests" agentType={SESSIONS.api.agent} showHeader />
      </div>
      <div className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <AssistantBlock content={BEFORE} timestamp={now - 40_000} messageId="hero-m-remote-before" agentType={SESSIONS.api.agent} showHeader={false} />
      </div>
      <div {...fly("desk/remote.browse")} className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <CastCommandBlock tool={BROWSE.tool} result={BROWSE.result} defaultExpanded />
      </div>
      <div {...fly("desk/remote.after")} className="conv-col mx-auto w-full px-4 sm:px-5 md:px-6 py-0.5 sm:py-1">
        <AssistantBlock content={AFTER} timestamp={now - 4_000} messageId="hero-m-remote-after" agentType={SESSIONS.api.agent} />
      </div>
    </div>
    </div>
  );
}
