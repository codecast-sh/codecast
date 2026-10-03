// Every Ops address, both ways: parseOpsPath reads a location into the view it
// names, and opsHref builds every link. The area registers one route family
// (/ops and /ops/*), so this file is the only place that knows the sub-paths.
// Pure: no React, no store.

export const OPS_TABS = ["timeline", "issues", "replays", "metrics", "apps"] as const;
export type OpsTab = (typeof OPS_TABS)[number];

export const OPS_TAB_LABEL: Record<OpsTab, string> = {
  timeline: "Timeline",
  issues: "Issues",
  replays: "Replays",
  metrics: "Metrics",
  apps: "Apps",
};

export type OpsView =
  | { view: "tab"; tab: OpsTab; source: string | null; app: string | null }
  | { view: "issue"; id: string }
  | { view: "replay"; id: string; t: number | null }
  | { view: "not-found"; path: string };

const enc = encodeURIComponent;

function dec(seg: string | undefined): string | null {
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function withQuery(path: string, query: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** Whether a path (with or without a query) is inside the Ops area. */
export function isOpsPath(path: string | null | undefined): boolean {
  return !!path && /^\/ops(?:[/?#]|$)/.test(path);
}

/** Every link into the area. Timeline is the area's front page, at /ops. */
export const opsHref = {
  tab: (tab: OpsTab, opts: { source?: string | null; app?: string | null } = {}) =>
    withQuery(tab === "timeline" ? "/ops" : `/ops/${tab}`, { source: opts.source, app: opts.app }),
  issue: (id: string) => `/ops/issues/${enc(id)}`,
  /** `t` is the scrubber position in ms from the start of the recording. */
  replay: (id: string, t?: number | null) => withQuery(`/ops/replays/${enc(id)}`, { t: t ?? null }),
};

export function parseOpsPath(pathname: string | null | undefined, query = ""): OpsView {
  const path = (pathname ?? "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/ops";
  const q = new URLSearchParams(query);
  const segs = path.split("/").filter(Boolean);
  if (segs[0] !== "ops") return { view: "not-found", path };
  const [, first, second, ...rest] = segs;
  const tabView = (tab: OpsTab): OpsView => ({ view: "tab", tab, source: q.get("source"), app: q.get("app") });
  if (!first) return tabView("timeline");
  if (rest.length) return { view: "not-found", path };
  if (first === "issues" && second) {
    const id = dec(second);
    return id ? { view: "issue", id } : { view: "not-found", path };
  }
  if (first === "replays" && second) {
    const id = dec(second);
    const t = Number(q.get("t"));
    return id ? { view: "replay", id, t: q.has("t") && Number.isFinite(t) && t >= 0 ? t : null } : { view: "not-found", path };
  }
  if (second) return { view: "not-found", path };
  if ((OPS_TABS as readonly string[]).includes(first) && first !== "timeline") return tabView(first as OpsTab);
  return { view: "not-found", path };
}

/** The label a browser tab or a recent visit wears for an Ops address. */
export function opsTabLabel(path: string): string {
  const [pathname, query] = path.split("?");
  const v = parseOpsPath(pathname, query ?? "");
  if (v.view === "issue") return v.id;
  if (v.view === "replay") return v.id;
  if (v.view === "tab") return v.tab === "timeline" ? "Ops" : `Ops · ${OPS_TAB_LABEL[v.tab]}`;
  return "Ops";
}
