/**
 * The setup card's link to the session's machine (contracts/agentToolSetup.ts):
 * where the Chrome extension or the macOS grants stand there, and the step
 * that moves them forward, both through the `agent_tool_setup` daemon command.
 *
 * A conversation can hold several failed `cast browser` rows, and every one
 * renders the card; the Agent features page asks about the same machine too.
 * They share one answer: the last check per target and tool lives here, and a
 * surface that mounts while it is fresh reads it instead of asking again. This is a probe of
 * a machine's local state, not server data, so it has no home in the store.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { AgentSetupTool, AgentToolSetupStatus } from "@codecast/shared/contracts";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { captureError } from "./analytics";
import { useWatchedCommand } from "./useProviderKeyCommand";

interface SetupEntry {
  status?: AgentToolSetupStatus;
  /** When the last check was sent; a fresh one is not sent again. */
  askedAt: number;
  error?: string;
}

/** A check younger than this answers every row that mounts. */
const FRESH_MS = 30_000;
/** After a start, the card checks this often until setup lands or the wait runs out. */
const RECHECK_MS = 3_000;
const START_WAIT_MS = 5 * 60_000;
/** A check the machine has not answered in this long: it is offline or its daemon predates the command. */
const CHECK_TIMEOUT_MS = 30_000;

const entries = new Map<string, SetupEntry>();
const listeners = new Set<() => void>();

function put(key: string, patch: Partial<SetupEntry>): void {
  entries.set(key, { askedAt: 0, ...entries.get(key), ...patch });
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Which machine to ask: a session's (its runner's device) or one of the viewer's devices. */
export type AgentSetupTarget = { conversationId: string } | { deviceId: string };

export function useAgentToolSetup(target: AgentSetupTarget | null, tool: AgentSetupTool, enabled: boolean) {
  const targetKey = !target ? null : "conversationId" in target ? `c:${target.conversationId}` : `d:${target.deviceId}`;
  const key = `${targetKey}:${tool}`;
  const entry = useSyncExternalStore(subscribe, () => entries.get(key), () => undefined);
  const enqueue = useMutation(api.devices.enqueueAgentToolSetupCommand);
  const checkCmd = useWatchedCommand(CHECK_TIMEOUT_MS);
  const startCmd = useWatchedCommand(CHECK_TIMEOUT_MS);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  const send = useCallback(async (op: "check" | "start"): Promise<string | null> => {
    if (!target) return null;
    try {
      const res = await enqueue({
        ...("conversationId" in target ? { conversation_id: target.conversationId as Id<"conversations"> } : { device_id: target.deviceId }),
        tool,
        op,
      });
      return res.command_id;
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)));
      put(key, { error: err instanceof Error ? err.message : "Couldn't reach codecast" });
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, enqueue, key, tool]);

  const check = useCallback(async () => {
    put(key, { askedAt: Date.now() });
    const id = await send("check");
    if (id) checkCmd.watch(id);
  }, [key, send, checkCmd.watch]);

  // One check per machine and tool while it is fresh, whichever surface mounts first.
  useWatchEffect(() => {
    if (!enabled || !targetKey) return;
    if (Date.now() - (entries.get(key)?.askedAt ?? 0) < FRESH_MS) return;
    void check();
  }, [enabled, targetKey, key, check]);

  // The machine's answer, shared with every surface asking about it.
  const outcome = checkCmd.outcome;
  useWatchEffect(() => {
    if (outcome?.state === "done" && outcome.setup) put(key, { status: outcome.setup, error: undefined });
    else if (outcome?.state === "failed") put(key, { error: outcome.error });
  }, [outcome, key]);
  useWatchEffect(() => {
    if (checkCmd.unanswered) put(key, { error: "The machine running this session did not answer. Is it online, with codecast up to date?" });
  }, [checkCmd.unanswered, key]);

  const start = useCallback(async () => {
    put(key, { error: undefined });
    const id = await send("start");
    if (!id) return;
    startCmd.watch(id);
    setWaitingSince(Date.now());
  }, [key, send, startCmd.watch]);

  const ready = !!entry?.status?.ready;
  // While a started step is pending, ask again every few seconds until it lands.
  useWatchEffect(() => {
    if (waitingSince === null) return;
    if (ready || Date.now() - waitingSince > START_WAIT_MS) {
      setWaitingSince(null);
      return;
    }
    const t = setTimeout(() => void check(), RECHECK_MS);
    return () => clearTimeout(t);
  }, [waitingSince, ready, entry?.status, check]);

  const startFailed = startCmd.outcome?.state === "failed" ? startCmd.outcome.error : null;
  return {
    status: entry?.status,
    error: startFailed ?? entry?.error ?? null,
    checking: enabled && !entry?.status && !entry?.error,
    /** A step was started on the machine and the card is waiting for it to land. */
    waiting: waitingSince !== null,
    check,
    start,
  };
}
