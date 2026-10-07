"use client";
// One project's line stations as the repo holds them (line-map.md LX5), and
// the edits on their way there. A station edit is a line profile edit of its
// own kind (set_station, reset_station): the same sessionCommands row, the
// same dispatch side effect and daemon command, so it travels exactly like a
// profile value (useLineProfileEdits) and settles the same way. This hook
// reads the project row from the store and adds what a station view needs:
// the line the stations come from (the repo's, else shipped), its version,
// where it differs from shipped, and whether the viewer can write it.
import { useCallback, useMemo } from "react";
import type { LineStationEdit, LineStationPatch, PublishedLineProfile, PublishedRepoLine } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../../store/inboxStore";
import { lineWriteGate, type RosterDevice } from "../../../lib/lineSettings";
import { SHIPPED_LINE } from "../../../lib/line/shippedLine.generated";
import { resetAllStationEdits, stationDiffs, type LineEdge, type LineNode, type StationField } from "../../../lib/line/lineStations";
import { useLineProfileEdits } from "./useLineProfileEdits";

export type LineStationsSource =
  /** The repo holds its own line: `.codecast/line/line.cast` at `graph_hash`. */
  | { kind: "repo"; line: PublishedRepoLine }
  /** The repo has no line of its own yet: its runs use the shipped line, and the first edit writes it out. */
  | { kind: "shipped" };

export function useLineStationEdits(projectId: string | null) {
  const published = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { line_profile?: PublishedLineProfile | null }>)?.[projectId]?.line_profile ?? null) : null));
  // Only a roster this session has heard live says a machine is offline.
  const roster = useInboxStore((s) => (s.machineRosterLive ? (s.machineRoster as RosterDevice[]) : null));
  const edits = useLineProfileEdits(projectId, published);
  const gate = useMemo(() => lineWriteGate(published, roster), [published, roster]);
  // The published copy with every station edit still travelling laid over it.
  const line = edits.lp?.line ?? null;
  const source: LineStationsSource = line ? { kind: "repo", line } : { kind: "shipped" };
  const nodes = (line?.nodes ?? SHIPPED_LINE.nodes) as LineNode[];
  const edges = (line?.edges ?? SHIPPED_LINE.edges) as LineEdge[];
  const diffs: Record<string, StationField[]> = useMemo(() => (line ? stationDiffs(line.nodes as LineNode[], SHIPPED_LINE) : {}), [line]);
  /** The version runs record (graph_hash) of what the repo holds now; null before the repo has a line or while an edit is being painted ahead of it. */
  const version = published?.line?.graph_hash || null;

  const { send } = edits;
  const setStation = useCallback((station: string, patch: LineStationPatch) => send([{ op: "set_station", station, ...patch }]), [send]);
  const resetStation = useCallback((station: string) => send([{ op: "reset_station", station }]), [send]);
  const resetAll = useCallback(() => {
    const all: LineStationEdit[] = resetAllStationEdits(nodes, SHIPPED_LINE);
    if (all.length) send(all);
  }, [send, nodes]);
  /** Where the newest edit of one station stands (sending, writing, saved, refused). */
  const stateOf = useCallback((station: string) => edits.states[`stations.${station}`], [edits.states]);
  const clear = useCallback((station: string) => edits.clear(`stations.${station}`), [edits]);

  return {
    /** A machine has published the project's profile, so the repo is the line's home (LX5). */
    inRepo: !!published?.root && !!published?.device_id,
    /** Edits go to the machine that published the profile; false sends nothing (gate.reason says why). */
    writable: gate.writable,
    gate,
    published,
    source,
    nodes,
    edges,
    diffs,
    version,
    setStation,
    resetStation,
    resetAll,
    stateOf,
    clear,
    now: edits.now,
  };
}
