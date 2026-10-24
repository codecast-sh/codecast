// The flows app as one pipeline (doc "Signals to shipped: one pipeline"):
// Signals, Problems, Flows, Decisions, Shipped. The header is the pipeline:
// each stage one number and one state, and the way into its view. Every view
// of the app sits under one stage, so the header marks where a person is
// whatever address they came by. Pure, so a test reads it.
import type { FlowMap, FlowMapGroup, FlowMapSource, FlowMapState } from "@codecast/shared/contracts/flowMap";
import { lineViewHome, type LineSelection, type LineSelectionPatch } from "./lineWorkspaceUrl";

export const PIPELINE_STAGES = ["signals", "problems", "flows", "decisions", "shipped"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_LABELS: Record<PipelineStage, string> = { signals: "Signals", problems: "Problems", flows: "Flows", decisions: "Decisions", shipped: "Shipped" };

/** The second key of the go chord (G, then this). No digit: an open decision answers on bare 1 to 9. */
export const PIPELINE_KEYS: Record<PipelineStage, string> = { signals: "s", problems: "p", flows: "f", decisions: "d", shipped: "h" };

export const pipelineStageForGoKey = (key: string): PipelineStage | null => PIPELINE_STAGES.find((s) => PIPELINE_KEYS[s] === key.toLowerCase()) ?? null;

/** The stage a selection sits under: a finder and the timeline are Signals' own pages, the library and the steps table
 *  the Flows stage's, Deploys Shipped's. */
export function pipelineStageOf(s: Pick<LineSelection, "view" | "source">): PipelineStage {
  switch (s.view) {
    case "signals": case "timeline": return "signals";
    case "problems": return "problems";
    case "foryou": return "decisions";
    case "shipped": case "deploys": return "shipped";
    case "flows": return "flows";
    case "line": return s.source ? "signals" : "flows";
  }
}

/** A stage's home: its view with nothing open. Flows opens the live flow's map. */
export function pipelineHome(stage: PipelineStage): LineSelectionPatch {
  switch (stage) {
    case "signals": return lineViewHome("signals");
    case "problems": return lineViewHome("problems");
    case "flows": return { ...lineViewHome("line"), mode: "map" };
    case "decisions": return lineViewHome("foryou");
    case "shipped": return lineViewHome("shipped");
  }
}

export type StageTone = "ok" | "live" | "ask" | "warn" | "bad" | "calm";
/** One stage in the header: its number with its unit, and its state in a few words, toned. */
export type StageFigure = { n: number | null; unit: string; state: Array<{ words: string; tone: StageTone }> };

/** The header's five figures. `forYou` is the Decisions view's own count, so the number and the list agree. A stage
 *  the map has not answered for reads null. */
export function pipelineFigures(map: FlowMap | null, forYou: number): Record<PipelineStage, StageFigure> {
  const src = map?.sources ?? [];
  const unfiled = src.filter((s) => s.route === "unfiled").length;
  const off = src.filter((s) => s.route === "off").length;
  const stopped = src.filter((s) => s.state === "stopped" && s.route !== "unfiled").length;
  const signalState: StageFigure["state"] = [
    ...(stopped ? [{ words: `${stopped} stopped`, tone: "bad" as const }] : []),
    ...(unfiled ? [{ words: `${unfiled} not filed`, tone: "bad" as const }] : []),
    ...(off ? [{ words: `${off} off the flow`, tone: "warn" as const }] : []),
  ];
  const live = map?.liveFlow ?? null;
  const stalled = (live?.stalled ?? 0) + (map?.off.stalled ?? 0);
  const flowState: StageFigure["state"] = !map ? [] : !live ? [{ words: "no live flow", tone: "calm" }]
    : [
      live.hold ? { words: `${live.label} held`, tone: "warn" as const } : { words: `${live.label} ${live.on ? "on" : "off"}`, tone: live.on ? ("live" as const) : ("calm" as const) },
      ...(stalled ? [{ words: `${stalled} stalled`, tone: "bad" as const }] : []),
    ];
  const h = map?.header;
  return {
    signals: { n: map ? src.length : null, unit: src.length === 1 ? "source" : "sources", state: map ? (signalState.length ? signalState : [{ words: "all flowing", tone: "ok" }]) : [] },
    problems: { n: h ? h.problemsOpen : null, unit: "open", state: h ? [{ words: `${h.problemsScored.toLocaleString()} scored`, tone: "ok" }] : [] },
    flows: { n: map ? (live?.running ?? 0) + (map.off.running ?? 0) : null, unit: "running", state: flowState },
    decisions: { n: forYou, unit: "for you", state: h ? [{ words: `${h.decisionsForTeam.toLocaleString()} for the team`, tone: h.decisionsForTeam ? "ask" : "calm" }] : [] },
    shipped: { n: h ? h.watching : null, unit: "watching", state: h ? [h.regressed ? { words: `${h.regressed.toLocaleString()} regressed`, tone: "bad" } : { words: "none regressed", tone: "ok" }] : [] },
  };
}

// ── Signals ────────────────────────────────────────────────────────────────

export const SIGNAL_GROUPS: ReadonlyArray<{ key: FlowMapGroup; label: string }> = [
  { key: "conversations", label: "Conversations" },
  { key: "people", label: "People" },
  { key: "product", label: "Product health" },
  { key: "pipeline", label: "AgentWatch itself" },
];

/** A source's state as its row shows it: an event kind that files nothing reads "not filed" whatever its pace. */
export type SignalRowState = FlowMapState | "unfiled";
export const signalRowState = (s: Pick<FlowMapSource, "state" | "route">): SignalRowState => (s.route === "unfiled" ? "unfiled" : s.state);

/** The counts above the table: by state, and the sources whose problems leave the live flow. */
export function signalCounts(sources: ReadonlyArray<FlowMapSource>): { flowing: number; quiet: number; stopped: number; off: number; unfiled: number } {
  const c = { flowing: 0, quiet: 0, stopped: 0, off: 0, unfiled: 0 };
  for (const s of sources) {
    if (s.route === "unfiled") { c.unfiled++; continue; }
    c[s.state]++;
    if (s.route === "off") c.off++;
  }
  return c;
}

/** Where a source's problems go, in the row's words: a lane's label, off the flow, or nowhere. */
export function routeWords(route: string, lanes: ReadonlyArray<{ key: string; label: string }>): { label: string; tone: "lane" | "off" | "unfiled" } {
  if (route === "unfiled") return { label: "Not filed", tone: "unfiled" };
  if (route === "off") return { label: "Off the flow", tone: "off" };
  return { label: lanes.find((l) => l.key === route)?.label ?? route, tone: "lane" };
}

/** The order of a source's outcomes in its bar, the order a problem moves through them. */
export const OUTCOME_ORDER = ["queued", "notReady", "running", "waiting", "shipped", "closed", "parked", "failed"] as const;
export const OUTCOME_LABELS: Record<(typeof OUTCOME_ORDER)[number], string> = { queued: "queued", notReady: "not ready", running: "running", waiting: "waiting on a person", shipped: "shipped", closed: "closed", parked: "parked", failed: "failed" };

/** "now", "40m", "4h", "6d": how long since a source's last signal. */
export function sinceWords(at: number | null, now: number): string {
  if (at == null) return "never";
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 5) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 72 ? `${h}h` : `${Math.round(h / 24)}d`;
}
