import { useMemo, useState } from "react";
import { isSilentAgentRow } from "@codecast/shared/chat";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { ProjectPathPicker } from "../ProjectPathPicker";
import { DeviceDot, deviceDisplayName } from "../DeviceBadge";
import { defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";
import { useSessionMachines } from "../../hooks/useSessionMachines";
import { useLocalDeviceId } from "../../hooks/useLocalDeviceId";
import { useDefaultAgentType } from "../../hooks/usePinnedAgents";
import { defaultSessionMachineId } from "../../lib/sessionMachines";
import { listedMachines } from "../../lib/machinePicker";
import { HAND_AGENTS, handAgentType, handLedger } from "../../lib/handToAgent";
import type { ChatMessageRow } from "../../store/chatSlice";

const ROW = "flex items-center gap-3 border-b border-sol-border/60 px-5 py-2.5 text-[12.5px]";
const LABEL = "w-[6rem] shrink-0 truncate text-sol-text-dim";

function threadFacts(channelId: string, rootKey: string) {
  const st = useInboxStore.getState();
  const channel = st.chatChannels[channelId] as { name?: string; kind?: string; team_id?: string } | undefined;
  const root = st.chatMessages[rootKey] as ChatMessageRow | undefined;
  let lines = root && !root.deleted_at ? 1 : 0;
  for (const id in st.chatMessages) {
    const row = st.chatMessages[id] as ChatMessageRow;
    if (row.thread_root_id === rootKey && !row.deleted_at && !isSilentAgentRow(row) && row.agent_status !== "thinking") lines++;
  }
  const prior = root?.bound_session_id ?? (root?.origin === "agent" ? root.origin_session_id : undefined);
  const priorKey = prior ? (st.getConvexId?.(prior) ?? prior) : null;
  const me = String(st.currentUser?._id ?? "");
  const priorRow = priorKey ? ((st.sessions as any)[priorKey] ?? (st.conversations as any)[priorKey] ?? (st.sessions as any)[prior!]) : null;
  const rootIsMine = !!root && root.origin !== "agent" && String(root.user_id) === me;
  const priorTheirs = !!priorKey && !rootIsMine && (priorRow
    ? !!priorRow.user_id && String(priorRow.user_id) !== me && String(priorRow.author_user_id ?? "") !== me && !priorRow.inbox_killed_at
    : true);
  return {
    place: channel?.kind === "dm" ? "Direct message" : `#${channel?.name ?? "channel"}`,
    teamId: channel?.team_id ?? null,
    preview: root?.content ?? "",
    lines: Math.max(lines, 1),
    rebind: priorKey && !priorTheirs ? (priorRow?.short_id ? `Session ${priorRow.short_id}` : "Another session") : null,
    held: priorTheirs,
    privateRoom: channel?.kind === "private" || channel?.kind === "dm",
    folder: defaultNewSessionPath(st as any, channel?.team_id ?? null),
  };
}

export function HandToAgentReview({ channelId, rootKey, message, preview, onClose }: {
  channelId: string;
  rootKey: string;
  message: string | Promise<string>;
  /** The line the person just wrote, when it is the ask (the composer in a thread). */
  preview?: string;
  onClose: (started: string | null) => void;
}) {
  const facts = useMemo(() => threadFacts(channelId, rootKey), [channelId, rootKey]);
  const fallbackAgent = useDefaultAgentType();
  const [agentType, setAgentType] = useState<string>(HAND_AGENTS.some((a) => a.type === fallbackAgent) ? fallbackAgent : "claude_code");
  const [folder, setFolder] = useState(facts.folder ?? "");
  const [picked, setPicked] = useState<string | null>(null);

  const allMachines = useSessionMachines();
  const devices = useMemo(() => allMachines.filter((d) => d.bot_name === undefined), [allMachines]);
  const localDeviceId = useLocalDeviceId(true);
  const defaultDevice = useInboxStore((s) => s.clientState.ui?.default_device ?? null);
  const lastPicked = useInboxStore((s) => s.clientState.ui?.last_picked_device_id ?? null);
  const machineId = picked ?? defaultSessionMachineId(devices as any, { projectPath: folder || undefined, defaultDevice, lastPicked, localDeviceId });
  const machines = useMemo(() => listedMachines(devices as any, machineId) as typeof devices, [devices, machineId]);
  const machine = machines.find((d) => d.device_id === machineId) ?? null;

  const ledger = handLedger({ ...facts, ...(preview ? { preview } : {}), agentType, folder, machine: machine ? deviceDisplayName(machine) : null, machineOffline: !!machine && !(machine as any).online });
  const start = () => {
    const stub = useInboxStore.getState().handThreadToAgent({ message, rootKey, agentType, projectPath: folder, targetDeviceId: machine?.device_id ?? null });
    onClose(stub);
  };

  return (
    <SwitchReview ledger={ledger} onClose={() => onClose(null)} onConfirm={start} onPick={(o) => setAgentType(handAgentType(o))}>
      <div className={ROW} data-hand-folder>
        <span className={LABEL}>Folder</span>
        <ProjectPathPicker value={folder} onChange={setFolder} className="min-w-0 flex-1" />
      </div>
      <div className={ROW} role="group" aria-label="Machine" data-hand-machine>
        <span className={LABEL}>Machine</span>
        <span className="inline-flex min-w-0 flex-wrap gap-1">
          {machines.length === 0 && <span className="text-sol-text-muted">None connected</span>}
          {machines.map((d) => (
            <button key={d.device_id} type="button" aria-pressed={d.device_id === machine?.device_id} onClick={() => setPicked(d.device_id)}
              className="inline-flex h-7 max-w-[12rem] items-center gap-1.5 rounded-md border border-sol-border px-2.5 text-sol-text-muted hover:text-sol-text aria-pressed:border-sol-orange aria-pressed:bg-sol-orange/15 aria-pressed:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50">
              <DeviceDot online={!!(d as any).online} />
              <span className="truncate">{deviceDisplayName(d)}</span>
            </button>
          ))}
        </span>
      </div>
    </SwitchReview>
  );
}
