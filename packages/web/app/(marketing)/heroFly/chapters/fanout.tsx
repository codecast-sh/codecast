"use client";

/**
 * Chapter 3, Fan out: the two workers the lead spawns, on the pair. Each
 * surface is a worker's own conversation: its header, the task the lead
 * handed it, its first tool call. The flyers carry each worker from its spawn
 * block in the lead's transcript to its row in the inbox, as that row.
 */

import { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } from "@/components/conversation/ConversationHeaderBar";
import { ConversationMetadata } from "@/components/conversation/sessionChrome";
import { AssistantBlock, UserPrompt } from "@/components/conversation/blocks/turnBlocks";
import { SessionCardView } from "@/components/inbox/SessionCardView";
import { fly, useFilmTime } from "../filmClock";
import { workerRow } from "../fixtures/desk";
import { BOOT, WORKERS, WORKER_SESSIONS, workerStatus } from "../fixtures/fanout";
import { CUES, SESSIONS } from "../fixtures/story";
import type { PartProps } from "./contract";

type Which = "api" | "ui";
const surfaceOf = { api: "pairA", ui: "pairB" } as const;

function WorkerHeader({ which }: { which: Which }) {
  // Nothing until the lead spawns it: before that the surface is a blank window.
  const status = useFilmTime((t) => (t < (which === "api" ? CUES.workerRowA : CUES.workerRowB) ? null : workerStatus(which, t)));
  const s = WORKER_SESSIONS[which];
  return (
    <div className="h-full bg-sol-bg">
      {status && <ConversationHeaderBar
        title={<ConversationHeaderTitle text={s.title} />}
        status={<AgentStatusPill agentStatus={status} />}
        facts={<ConversationMetadata agentType={s.agent} model={WORKERS[which].model} />}
      />}
    </div>
  );
}

function WorkerBoot({ which, now }: { which: Which; now: number }) {
  const step = useFilmTime((t) => (t < BOOT[which].prompt ? 0 : t < BOOT[which].tool ? 1 : 2));
  const w = WORKERS[which];
  const surface = surfaceOf[which];
  if (step === 0) return null;
  return (
    <div className="px-3 pb-1">
      <div {...fly(`${surface}/fanout.prompt:${which}`)}>
        <UserPrompt content={w.task} timestamp={now - 4_000} messageId={`hero-m-boot-${which}`} userName={SESSIONS.lead.title} avatarUrl={null} />
      </div>
      {step === 2 && (
        <div {...fly(`${surface}/fanout.tool:${which}`)}>
          <AssistantBlock
            toolCalls={[w.tool]}
            toolResults={[w.result]}
            timestamp={now - 2_000}
            messageId={`hero-m-tool-${which}`}
            agentType={WORKER_SESSIONS[which].agent}
          />
        </div>
      )}
    </div>
  );
}

export function HeaderA(_: PartProps) {
  return <WorkerHeader which="api" />;
}

export function HeaderB(_: PartProps) {
  return <WorkerHeader which="ui" />;
}

export function BootA({ now }: PartProps) {
  return <WorkerBoot which="api" now={now} />;
}

export function BootB({ now }: PartProps) {
  return <WorkerBoot which="ui" now={now} />;
}

/** A worker in flight: the row it is about to become, lifted off the page. */
function SpawnCard({ which, now }: { which: Which; now: number }) {
  return (
    <div className="w-[340px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md border border-sol-border/40 bg-sol-bg-alt shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45)]">
      <SessionCardView
        session={workerRow(now, which, "working")}
        isActive={false}
        isFavorite={false}
        sessionLabel={null}
        now={now}
        chrome={{ showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false }}
        liveness={{ isLive: true, pendingSend: false, restarting: false, draft: "" }}
        viewerId={null}
        author={null}
        viewers={[]}
        spawnedByTitle={SESSIONS.lead.title}
        anchorIdentity={null}
        onSelect={() => {}}
      />
    </div>
  );
}

export function SpawnFlyerA({ now }: PartProps) {
  return <SpawnCard which="api" now={now} />;
}

export function SpawnFlyerB({ now }: PartProps) {
  return <SpawnCard which="ui" now={now} />;
}
