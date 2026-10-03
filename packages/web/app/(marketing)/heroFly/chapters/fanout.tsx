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
import { fly, useFilmTime } from "../filmClock";
import { FilmDip, FilmGrow, LiftedRow } from "../film";
import { workerRow } from "../fixtures/desk";
import { BOOT, WORKERS, WORKER_SESSIONS, workerStatus } from "../fixtures/fanout";
import { CUES, PEOPLE, SESSIONS } from "../fixtures/story";
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
        status={
          <span {...fly(`${surfaceOf[which]}/fanout.status:${which}`)} className="inline-flex origin-left">
            {/* The API worker's turn ends on its question (idle shows no pill): the pill clears and returns on the answer with a fade, never in one frame. */}
            {which === "api" ? (
              <FilmDip out={CUES.question} back={CUES.answered}>
                <AgentStatusPill agentStatus={status === "idle" ? "working" : status} />
              </FilmDip>
            ) : (
              <AgentStatusPill agentStatus={status} />
            )}
          </span>
        }
        facts={<ConversationMetadata agentType={s.agent} model={WORKERS[which].model} />}
      />}
    </div>
  );
}

/** The task the lead handed a worker, as the worker's first message: the spawn's prompt, sent as Alex (the lead runs as Alex), so it reads as Alex's own message. */
export function WorkerTask({ which, now }: { which: Which; now: number }) {
  return <UserPrompt content={WORKERS[which].task} timestamp={now - 4_000} messageId={`hero-m-boot-${which}`} userName={PEOPLE.me.name} avatarUrl={null} />;
}

/** The worker's plan, its first answer. */
export function WorkerPlan({ which, now }: { which: Which; now: number }) {
  return <AssistantBlock content={WORKERS[which].plan} timestamp={now - 3_000} messageId={`hero-m-plan-${which}`} agentType={WORKER_SESSIONS[which].agent} />;
}

function WorkerBoot({ which, now }: { which: Which; now: number }) {
  const step = useFilmTime((t) => (t < BOOT[which].prompt ? 0 : t < BOOT[which].seed ? 1 : 2));
  const w = WORKERS[which];
  const surface = surfaceOf[which];
  const agentType = WORKER_SESSIONS[which].agent;
  if (step === 0) return null;
  return (
    <div className="px-3 pb-1" {...fly(`${surface}/fanout.feed:${which}`)}>
      <div {...fly(`${surface}/fanout.prompt:${which}`)}>
        <WorkerTask which={which} now={now} />
      </div>
      {step >= 2 && (
        <div {...fly(`${surface}/fanout.seed:${which}`)}>
          <WorkerPlan which={which} now={now} />
          <AssistantBlock toolCalls={[w.seed]} toolResults={[w.seedResult]} timestamp={now - 3_000} messageId={`hero-m-seed-${which}`} agentType={agentType} showHeader={false} />
        </div>
      )}
      {/* Lands while the camera holds on the pair: it opens its room, so the transcript above rises with it rather than jumping. */}
      <FilmGrow at={BOOT[which].tool} dur={0.5}>
        <div {...fly(`${surface}/fanout.tool:${which}`)}>
          <AssistantBlock toolCalls={[w.tool]} toolResults={[w.result]} timestamp={now - 2_000} messageId={`hero-m-tool-${which}`} agentType={agentType} showHeader={false} />
        </div>
      </FilmGrow>
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

/** A worker in flight: the row it is about to become. */
function SpawnCard({ which, now }: { which: Which; now: number }) {
  return <LiftedRow session={workerRow(now, which, "working")} now={now} spawnedByTitle={SESSIONS.lead.title} />;
}

export function SpawnFlyerA({ now }: PartProps) {
  return <SpawnCard which="api" now={now} />;
}

export function SpawnFlyerB({ now }: PartProps) {
  return <SpawnCard which="ui" now={now} />;
}
