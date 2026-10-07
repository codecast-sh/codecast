// The map's state lives in its URL, so any panel, window or trace on it is a
// link (docs/architecture/line-map.md LX1, LX3): `?node=<id>` or `?edge=<id>`
// opens a panel, `?window=24h|7d|30d` picks the window, `?trace=<ref>` draws
// one thing's path. `node=line` is the panel for the whole line's settings,
// and `section=` scrolls it, which is where /line/settings lands.
import { LINE_MAP_WINDOWS, type LineMapWindow } from "./lineMap";

/** The panel that holds every value of the line at once: its file, finders, checks and limits. */
export const LINE_SETTINGS_NODE = "line";
export const DEFAULT_MAP_WINDOW: LineMapWindow = "7d";

export type LineMapState = { node: string | null; edge: string | null; window: LineMapWindow; trace: string | null; section: string | null };

type Search = { get(key: string): string | null } | null | undefined;

const isWindow = (w: string | null | undefined): w is LineMapWindow => !!w && w in LINE_MAP_WINDOWS;

export function readLineMapState(search: Search): LineMapState {
  const w = search?.get("window");
  const edge = search?.get("edge") || null;
  return {
    // One panel at a time: an edge wins over a node.
    node: edge ? null : search?.get("node") || null,
    edge,
    window: isWindow(w) ? w : DEFAULT_MAP_WINDOW,
    trace: search?.get("trace") || null,
    section: search?.get("section") || null,
  };
}

/** The same address with the map's params changed; null removes one, and the default window is left out. */
export function lineMapSearch(current: Search & { toString(): string }, patch: Partial<Record<keyof LineMapState, string | null>>): string {
  const q = new URLSearchParams(current?.toString() ?? "");
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || (k === "window" && v === DEFAULT_MAP_WINDOW)) q.delete(k);
    else q.set(k, v);
  }
  // A panel change drops the other panel's key and a stale section.
  if (patch.node !== undefined || patch.edge !== undefined) {
    if (patch.node) q.delete("edge");
    if (patch.edge) q.delete("node");
    if (patch.section === undefined && patch.node !== LINE_SETTINGS_NODE) q.delete("section");
  }
  // The settings page's station param means nothing on the map.
  q.delete("station");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** One thing followed through the line (LX4). */
export const lineTraceHref = (ref: string) => `/line/trace/${encodeURIComponent(ref)}`;

/** Where a /line/settings link lands on the map: a station's panel, or the line's settings panel at the section. */
export function settingsOnMap(search: Search): string {
  const q = new URLSearchParams();
  const project = search?.get("project");
  if (project) q.set("project", project);
  const station = search?.get("station");
  const section = search?.get("section");
  if (station) q.set("node", station);
  else {
    q.set("node", LINE_SETTINGS_NODE);
    if (section) q.set("section", section);
  }
  return `/line?${q.toString()}`;
}
