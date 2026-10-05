"use client";
// One project's edits in flight, by the key each touches. An edit paints the
// store at once (store/lineSlice.ts editLineProfile) and goes to the daemon
// holding the file; this tracks what the page says beside the value while it
// travels: sending (on its way to the server), waiting (with the machine),
// saved, or refused with the loader's message. A refusal from the server or
// the daemon puts the painted keys back. What the value IS stays in the store;
// only the journey is kept here.
import { useCallback, useEffect, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError } from "@codecast/shared/contracts";
import type { LineProfileEdit, PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../store/mutativeMiddleware";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { editKey, editOutcome } from "../../../lib/lineSettings";

export type EditState =
  | { state: "sending"; at: number }
  | { state: "waiting"; at: number; commandId: string; prior: PublishedLineProfile; keys: string[] }
  | { state: "saved"; at: number; note?: string }
  | { state: "refused"; at: number; message: string };

export function useLineProfileEdits(projectId: string | null, lp: PublishedLineProfile | null | undefined) {
  const [states, setStates] = useState<Record<string, EditState>>({});
  // A new project starts clean: another line's states mean nothing here.
  useEffect(() => setStates({}), [projectId]);

  const put = useCallback((keys: string[], s: EditState) => setStates((cur) => {
    const next = { ...cur };
    for (const k of keys) next[k] = s;
    return next;
  }), []);

  /** Send edits that share one fate; `as` names the row that shows it (default: each edit's key). */
  const send = useCallback((edits: LineProfileEdit[], as?: string) => {
    if (!projectId || !lp || edits.length === 0) return;
    const keys = as ? [as] : edits.map(editKey);
    const restoreKeys = edits.map(editKey);
    const prior = structuredClone(lp);
    const at = Date.now();
    put(keys, { state: "sending", at });
    const st = useInboxStore.getState();
    st.editLineProfile(projectId, edits).then(
      (r) => {
        if (r?.command_id) put(keys, { state: "waiting", at, commandId: r.command_id, prior, keys: restoreKeys });
      },
      (err) => {
        // Only a refusal: a write parked for the next binding is still on its way.
        if (!isRefusedDispatchError(err)) return;
        useInboxStore.getState().restoreLineProfile(projectId, prior, restoreKeys);
        put(keys, { state: "refused", at, message: humanizeConvexError(err, "The edit was refused") });
      },
    );
  }, [projectId, lp, put]);

  /** The daemon answered a waiting edit (CommandWatch below). */
  const settle = useCallback((key: string, s: EditState & { state: "waiting" }, answer: Parameters<typeof editOutcome>[0]) => {
    const out = editOutcome(answer);
    if (out.state === "waiting") return;
    if (out.state === "refused" && projectId) useInboxStore.getState().restoreLineProfile(projectId, s.prior, s.keys);
    setStates((cur) => (cur[key] === s ? { ...cur, [key]: out.state === "saved" ? { state: "saved", at: Date.now(), note: out.note } : { state: "refused", at: Date.now(), message: out.message } } : cur));
  }, [projectId]);

  const clear = useCallback((key: string) => setStates((cur) => {
    if (!cur[key]) return cur;
    const { [key]: _gone, ...rest } = cur;
    return rest;
  }), []);

  return { states, send, settle, clear };
}

/** Watches one waiting edit's daemon command and reports its answer. Renders nothing. */
export function CommandWatch({ id, s, onAnswer }: { id: string; s: EditState & { state: "waiting" }; onAnswer: (key: string, s: EditState & { state: "waiting" }, answer: any) => void }) {
  const { data } = useQueryNoThrow(api.users.getCommandResult, { command_id: s.commandId as any });
  useEffect(() => {
    if (data?.executed_at) onAnswer(id, s, data);
  }, [data, id, s, onAnswer]);
  return null;
}
