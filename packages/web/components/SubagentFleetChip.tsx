import React, { useMemo } from "react";
import { mergeBackLabel, queueAhead, queuedLabel, type MergeBackStatus, type SlotRow, type SubagentSlot } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

type FleetRow = {
  _id: string;
  parent_conversation_id?: string | null;
  subagent_slot?: SubagentSlot | null;
  subagent_slot_at?: number | null;
  subagent_slot_device?: string | null;
  merge_back?: MergeBackStatus | null;
};

/** The queued rows in the store, as a string that changes only when the queue does. */
function queueSig(sessions: Record<string, FleetRow>): string {
  const parts: string[] = [];
  for (const row of Object.values(sessions)) {
    if (row?.subagent_slot !== "queued") continue;
    parts.push([row._id, row.subagent_slot_at ?? 0, row.parent_conversation_id ?? "", row.subagent_slot_device ?? ""].join("|"));
  }
  return parts.sort().join("\n");
}

function queueRows(sig: string): SlotRow[] {
  if (!sig) return [];
  return sig.split("\n").map((line) => {
    const [id, at, parent, device] = line.split("|");
    return { id, at: Number(at), parent: parent || null, device: device || null, slot: "queued" as const, caps: { per_session: 0, per_machine: 0 } };
  });
}

const MERGE_TONE: Record<MergeBackStatus["state"], string> = {
  pending: "text-sol-violet animate-pulse",
  merged: "text-sol-green",
  empty: "text-sol-text-dim",
  conflict: "text-sol-red",
  kept: "text-sol-yellow",
  failed: "text-sol-red",
};

/**
 * A worker's place in the subagent fleet: "queued, 2 ahead" while it waits
 * for a slot (its place derived from the queued rows in the store), and once
 * it ends, what became of its worktree's changes.
 */
export function SubagentFleetChip({ session }: { session: FleetRow }) {
  const queued = session.subagent_slot === "queued";
  const sig = useInboxStore((s) => (queued ? queueSig(s.sessions as Record<string, FleetRow>) : ""));
  const ahead = useMemo(() => (queued ? queueAhead(String(session._id), queueRows(sig)) : 0), [queued, sig, session._id]);

  if (queued) {
    return (
      <span
        data-fleet-chip="queued"
        className="inline-flex shrink-0 text-[9px] font-mono text-sol-violet"
        title="Waiting for a subagent slot. It starts when a running worker of this session or machine ends done, blocked or killed (cast config subagents.per_session / per_machine)."
      >
        {queuedLabel(ahead)}
      </span>
    );
  }
  const merge = session.merge_back;
  if (!merge) return null;
  const files = merge.files?.length ? `\n${merge.files.join("\n")}` : "";
  const title = {
    pending: "Bringing this worker's changes into its parent's checkout.",
    merged: "This worker's changes are in its parent's checkout, uncommitted:",
    empty: "This worker changed nothing its parent's checkout lacked.",
    conflict: "Not merged: the parent's checkout changed the same lines in these files. The worktree keeps the work:",
    kept: "This worker did not finish done, so its changes stay in its worktree.",
    failed: `Could not merge${merge.reason ? `: ${merge.reason}` : ""}. The worktree keeps the work.`,
  }[merge.state] + files;
  return (
    <span data-fleet-chip={merge.state} className={`inline-flex shrink-0 text-[9px] font-mono ${MERGE_TONE[merge.state]}`} title={title}>
      {mergeBackLabel(merge)}
    </span>
  );
}
