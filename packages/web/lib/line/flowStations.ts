// What one station of a flow does, whole (docs/architecture/flows.md FL6): who
// does it, with which model and limits, the words it runs (its prompt, its
// script, the document a person decides on), and where each outcome sends the
// work. A pushed flow carries its stations' words in its own row (pushedFlow
// keeps them on the AppFlow); a shipped flow's live in a snapshot the CLI
// generates, loaded the first time anyone opens a station.
import { useEffect, useState } from "react";

export type StationDetail = {
  prompt?: string;
  script?: string;
  system?: string;
  doc?: string;
  model?: string;
  reasoning_effort?: string;
  backend?: string;
  agent?: string;
  definition?: string;
  isolated?: boolean;
  reviewer?: boolean;
  timeout?: number;
  max_visits?: number;
  max_retries?: number;
  parks?: boolean;
  output?: string;
  max_tokens?: number;
};
export type FlowStations = Record<string, StationDetail>;
/** The shipped snapshot's form: texts named by index into its TEXTS. */
export type PackedStations = Record<string, Record<string, string | number | boolean>>;

const TEXT_FIELDS = ["prompt", "script", "system", "doc"] as const;
const SETTING_FIELDS = ["model", "reasoning_effort", "backend", "agent", "definition", "isolated", "reviewer", "timeout", "max_visits", "max_retries", "parks", "output", "max_tokens"] as const;

/** The stations of a stored graph (a workflows row, a session's flow), by node id. */
export function stationsOfNodes(nodes: ReadonlyArray<Record<string, unknown> & { id: string }>): FlowStations {
  const out: FlowStations = {};
  for (const n of nodes) {
    const d: Record<string, unknown> = {};
    for (const k of [...TEXT_FIELDS, ...SETTING_FIELDS]) if (n[k] !== undefined && n[k] !== null && n[k] !== "") d[k] = n[k];
    if (Object.keys(d).length) out[n.id] = d as StationDetail;
  }
  return out;
}

let shipped: Record<string, FlowStations> | null = null;
let loading: Promise<Record<string, FlowStations>> | null = null;

function loadShipped(): Promise<Record<string, FlowStations>> {
  loading ??= import("./shippedFlowStations.generated").then(({ TEXTS, STATIONS }) => {
    const unpacked: Record<string, FlowStations> = {};
    for (const [slug, packed] of Object.entries(STATIONS)) {
      unpacked[slug] = Object.fromEntries(Object.entries(packed).map(([id, d]) => [id, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (TEXT_FIELDS as readonly string[]).includes(k) ? TEXTS[v as number] : v]))]));
    }
    shipped = unpacked;
    return unpacked;
  });
  return loading;
}

type FlowLike = { slug: string; where: "shipped" | "pushed" | "team"; stationDetails?: FlowStations | null };

/** A flow's stations: at once for a pushed flow, after one load for a shipped one (undefined until then). */
export function useFlowStations(flow: FlowLike | null, enabled = true): FlowStations | undefined {
  const isShipped = flow?.where === "shipped";
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!enabled || !isShipped || shipped) return;
    let live = true;
    void loadShipped().then(() => live && rerender((n) => n + 1));
    return () => { live = false; };
  }, [enabled, isShipped]);
  if (!flow) return undefined;
  if (!isShipped) return flow.stationDetails ?? {};
  return shipped ? shipped[flow.slug] ?? {} : undefined;
}
