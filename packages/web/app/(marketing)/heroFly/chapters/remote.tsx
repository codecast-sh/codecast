"use client";

/**
 * Chapter 13, Anywhere: an inset over the desk naming where the work runs:
 * the machine row (your laptop and a cloud host), the session running on the
 * cloud host as its inbox row, its tmux pane and the page its agent drives,
 * and the `cast computer` call driving it.
 */

import type { ReactNode } from "react";
import { MachineChips } from "@/components/MachineChips";
import { TmuxAttachPill } from "@/components/TmuxAttachPill";
import { SessionCardView } from "@/components/inbox/SessionCardView";
import { WatchAddress } from "@/components/browser/watchControls";
import { CastCommandBlock } from "@/components/conversation/blocks/castBlocks";
import { fly, useFilmTime } from "../filmClock";
import { CLOUD_HOST, inboxRows } from "../fixtures/desk";
import { ADDRESS, COMPUTER, INSET, MACHINES, TMUX_PANE } from "../fixtures/remote";
import type { PartProps } from "./contract";
import { DeskRouter } from "./desk";

const noop = () => {};

function Line({ id, children }: { id: number; children: ReactNode }) {
  return (
    <div {...fly(`desk/remote.line:${id}`)} className="flex items-center gap-2 min-w-0">
      {children}
    </div>
  );
}

export function Anywhere({ now }: PartProps) {
  const shown = useFilmTime((t) => t >= INSET.cue);
  if (!shown) return null;
  const host = inboxRows(now).find((r) => r.runHost)!;
  return (
    <DeskRouter>
      <div {...fly("desk/remote.inset")} className="relative z-20 h-full p-3 flex flex-col gap-2 rounded-xl border border-sol-border bg-sol-bg-alt shadow-[0_24px_60px_-20px_rgba(0,43,54,0.45)] overflow-hidden">
        <Line id={0}>
          <MachineChips machines={MACHINES} selectedDeviceId={CLOUD_HOST.device_id} open onOpen={noop} onPick={noop} />
        </Line>
        <div {...fly("desk/remote.line:1")} className="rounded-md border border-sol-border/40 overflow-hidden">
          <SessionCardView
            session={host.session}
            isActive={false}
            isFavorite={false}
            sessionLabel={null}
            now={now}
            chrome={{ showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false }}
            liveness={{ isLive: true, pendingSend: false, restarting: false, draft: "" }}
            viewerId={null}
            author={null}
            viewers={[]}
            spawnedByTitle={null}
            anchorIdentity={null}
            runHost={host.runHost}
            onSelect={noop}
          />
        </div>
        <Line id={2}>
          <TmuxAttachPill tmuxSession={TMUX_PANE} agentType="pi" isLive />
          <WatchAddress url={ADDRESS} nav={null} />
        </Line>
        <div {...fly("desk/remote.line:3")} className="min-w-0">
          <CastCommandBlock tool={COMPUTER.tool} result={COMPUTER.result} />
        </div>
      </div>
    </DeskRouter>
  );
}
