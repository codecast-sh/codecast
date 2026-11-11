// The Volume page's model (VolumePage): what holds work, each block with its
// count and where to act on it, and the words for where a problem stands.
// Read from the flow map (its rollup's backlog and coverage) and the live
// flow's row. Pure, so a test reads it.
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { RECORDING, coverageTotals, type BacklogStand, type CoverageDay } from "@codecast/shared/contracts/lineVolume";
import type { LineSelectionPatch } from "./lineWorkspaceUrl";

export const STAND_WORDS: Record<BacklogStand, string> = {
  noproject: "in no project", nolead: "project has no lead", offsource: "source not taken", notready: "not ready", nogoal: "no goal named",
  underbar: "under the bar", eligible: "eligible, not started", running: "running", waiting: "on a person", land: "ready to land",
  stalled: "stalled", failed: "failed", watching: "under watch", inhand: "with a person", other: "run ended, still open",
};

/** The live flow as the blocks read it (useLiveFlow's row). */
export type VolumeLive = {
  on: boolean;
  hold: { why: string; until: number | null } | null;
  caps: { hands_per_day: number | null };
  hands_today: number;
  load: { working: number; cap: number };
  machines?: { online: number; total: number };
} | null;

/** Where a block acts: name a project's lead, open the problems behind it, go to a view, or open a page. */
export type BlockAct =
  | { kind: "lead"; project: string }
  | { kind: "show"; show: string }
  | { kind: "go"; patch: LineSelectionPatch }
  | { kind: "page"; href: string; label: string };
export type VolumeBlock = { key: string; n: string; weight: number; label: string; tone: "bad" | "warn" | "ask"; act: BlockAct | null };

const SETTINGS = { kind: "page", href: "/flows/settings", label: "Flow settings" } as const;
const fmt = (n: number) => n.toLocaleString();

/** A source's kind as a person reads it. */
export const coverageKindWords = (kind: string) => (kind === RECORDING ? "recordings" : `${kind} moments`);

/** What a coverage row left unread: a recording not judged, a moment failed or not judged yet. */
export const unread = (c: { kind: string }, t: Omit<CoverageDay, "day">) => (c.kind === RECORDING ? t.arrived - t.judged : t.failed + t.waiting);

/** A recording source's judged count comes from its replay moments (a judge reads a recording through one). */
export function coverageRows(map: Pick<FlowMap, "coverage">, now: number, days: number) {
  const rows = map.coverage ?? [];
  return rows.map((c) => {
    const t = coverageTotals(c, now, days);
    const today = coverageTotals(c, now, 1);
    if (c.kind === RECORDING) {
      const judged = rows.find((r) => r.source_id === c.source_id && r.kind === "replay");
      if (judged) { t.judged = coverageTotals(judged, now, days).judged; today.judged = coverageTotals(judged, now, 1).judged; }
    }
    return { ...c, t, today, gap: unread(c, t), todayGap: unread(c, today) };
  }).sort((a, b) => b.t.arrived - a.t.arrived);
}

/** What holds work, largest first. */
export function volumeBlocks(map: FlowMap, live: VolumeLive, now: number, days: number): VolumeBlock[] {
  const out: VolumeBlock[] = [];
  const b = map.backlog;
  for (const p of b?.projects ?? []) {
    if (p.stand !== "nolead" || !p.project) continue;
    const title = map.backlogProjects?.[p.project]?.title ?? "A project";
    out.push({ key: `nolead:${p.project}`, n: fmt(p.n), weight: p.n, label: `${title} has no lead`, tone: "bad", act: { kind: "lead", project: p.project } });
  }
  const stand = (s: BacklogStand) => b?.stands.find((x) => x.stand === s)?.n ?? 0;
  if (stand("noproject")) out.push({ key: "noproject", n: fmt(stand("noproject")), weight: stand("noproject"), label: "in no project", tone: "bad", act: { kind: "show", show: "stand:noproject" } });
  if (stand("offsource")) out.push({ key: "offsource", n: fmt(stand("offsource")), weight: stand("offsource"), label: "source not taken by the flow", tone: "warn", act: { kind: "show", show: "stand:offsource" } });
  if (live) {
    if (!live.on) out.push({ key: "off", n: "Off", weight: 1e9, label: "flow is off", tone: "bad", act: SETTINGS });
    else if (live.hold) out.push({ key: "hold", n: "Held", weight: 1e9, label: live.hold.why, tone: "bad", act: SETTINGS });
    const cap = live.caps.hands_per_day;
    if (cap != null && live.hands_today >= cap) out.push({ key: "hands", n: `${live.hands_today}/${cap}`, weight: 1e8, label: "hands used today", tone: "warn", act: SETTINGS });
    if (live.machines && live.machines.online < live.machines.total) out.push({ key: "machines", n: `${live.machines.online}/${live.machines.total}`, weight: 1e8, label: "machines online", tone: "bad", act: SETTINGS });
    if (live.load.cap > 0 && live.load.working >= live.load.cap) out.push({ key: "slots", n: `${live.load.working}/${live.load.cap}`, weight: 1e7, label: "slots busy", tone: "warn", act: null });
  }
  const decisions = map.header.decisionsForYou + map.header.decisionsForTeam;
  if (decisions) out.push({ key: "decisions", n: fmt(decisions), weight: decisions, label: map.header.decisionsForYou ? `decisions waiting, ${fmt(map.header.decisionsForYou)} on you` : "decisions waiting on the team", tone: "ask", act: { kind: "go", patch: { view: "foryou" } } });
  for (const s of ["stalled", "failed"] as const) if (stand(s)) out.push({ key: s, n: fmt(stand(s)), weight: stand(s), label: s === "stalled" ? "runs stalled 8h+" : "runs failed, problem still open", tone: "bad", act: { kind: "show", show: `stand:${s}` } });
  for (const c of coverageRows(map, now, days)) {
    if (c.kind === "replay" || c.gap <= 0) continue;
    const what = c.kind === RECORDING ? `${c.label} recordings not judged` : `${c.label} ${c.kind} moments unread, ${fmt(c.t.failed)} failed`;
    out.push({ key: `src:${c.source_id}:${c.kind}`, n: fmt(c.gap), weight: c.gap, label: what, tone: c.gap > c.t.arrived / 10 ? "bad" : "warn", act: { kind: "show", show: `src:${c.source_id}:${c.kind}` } });
  }
  return out.sort((a, b) => b.weight - a.weight);
}
