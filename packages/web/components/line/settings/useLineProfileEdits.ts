"use client";
// One project's line, as the settings page shows it, and the edits on their
// way to its file. Each edit is a sessionCommands row (store/lineSlice.ts),
// fed to the end of its journey by the window's sessionCommands feeder
// (useSessionCommandResults), so leaving the page loses nothing. This hook
// only reads: the profile with the travelling edits laid over it, and per
// key where the newest edit of that key stands.
import { useCallback, useMemo } from "react";
import type { LineProfileEdit, PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../../store/inboxStore";
import { newRequestId } from "../../../lib/sessionCommands";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { lineEditRows, lineEditStates, lineWriteGate, liveLineProfile, type LineEditStatus, type RosterDevice } from "../../../lib/lineSettings";

export type EditState = LineEditStatus;

const rowSig = (r: any) => `${r._id}|${r.command_id ?? ""}|${r.executed_at ?? ""}|${r.result ?? ""}|${r.error ?? ""}`;

export function useLineProfileEdits(projectId: string | null, published: PublishedLineProfile | null | undefined) {
  // A signature of this project's edit rows: a heartbeat on another command
  // row never re-renders the page.
  const sig = useInboxStore((s) => {
    if (!projectId) return "";
    let out = "";
    for (const id in s.sessionCommands) {
      const r = (s.sessionCommands as Record<string, any>)[id];
      if (r?.kind === "line_edit" && r.project_id === projectId) out += `${rowSig(r)};`;
    }
    return out;
  });
  // Time moves an edit from writing to slow, and a republish that never came
  // to a note; a coarse tick is enough for both.
  const now = useCoarseNow(sig ? 5_000 : 60_000);
  const rows = useMemo(
    () => lineEditRows(useInboxStore.getState().sessionCommands, projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, sig],
  );
  const lp = useMemo(() => liveLineProfile(published, rows, now), [published, rows, now]);
  const states = useMemo(() => lineEditStates(rows, published, now), [rows, published, now]);

  /** Send edits that share one fate. */
  const send = useCallback((edits: LineProfileEdit[]) => {
    if (!projectId || edits.length === 0) return;
    // A refusal settles the row (lib/dispatchBinding); the page reads it there.
    useInboxStore.getState().editLineProfile(newRequestId(), projectId, edits).catch(() => {});
  }, [projectId]);

  /** Forget an edit: a refusal read, or one whose machine never answered, which also stops showing it. */
  const clear = useCallback((key: string) => {
    const s = states[key];
    if (s) useInboxStore.getState().dismissSessionCommand(s.requestId);
  }, [states]);

  return { lp, states, send, clear, now };
}

/**
 * Everything a surface that edits one project's profile needs: the published
 * copy (by reference; the floor's project signature watches only part of
 * it), the edits travelling over it, and who can write the file (the
 * machine an edit goes to, or why nothing can). Line settings and a map
 * panel's values both read it here.
 */
export function useLineProfileEditor(projectId: string | null) {
  const published = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { line_profile?: PublishedLineProfile | null }>)[projectId]?.line_profile ?? null) : null));
  // Only a roster this session has heard live says a machine is offline; a
  // cached one from an earlier visit would lock the page on a stale flag.
  const roster = useInboxStore((s) => (s.machineRosterLive ? (s.machineRoster as RosterDevice[]) : null));
  const edits = useLineProfileEdits(projectId, published);
  const gate = useMemo(() => lineWriteGate(published, roster), [published, roster]);
  return { published, edits, gate, device: gate.device ?? "the machine" };
}
