// Every Ops address, both ways. The Ops views live under the flows app's
// Signals stage (doc "Signals to shipped: one pipeline"): a source's issues,
// replays, metrics and apps open there, at /flows?view=signals&sig=<tab>.
// opsHref builds every link there, opsViewOf reads one back, and parseOpsPath
// reads an old /ops address, which redirects to the same view. This file is
// the only place that knows the addresses. Pure: no React, no store.

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

/** Whether a path (with or without a query) is an Ops view: an old /ops address, or a source view under Signals. */
export function isOpsPath(path: string | null | undefined): boolean {
  return !!path && (/^\/ops(?:[/?#]|$)/.test(path) || (/^\/flows\?/.test(path) && /[?&]sig=/.test(path)));
}

const SIGNALS = "/flows";
const sig = (tab: OpsTab, query: Record<string, string | number | null | undefined> = {}) => withQuery(SIGNALS, { view: "signals", sig: tab, ...query });

/** Every link into a source view. */
export const opsHref = {
  tab: (tab: OpsTab, opts: { source?: string | null; app?: string | null } = {}) => sig(tab, { source: opts.source, app: opts.app }),
  issue: (id: string) => sig("issues", { item: id }),
  /** `t` is the scrubber position in ms from the start of the recording. */
  replay: (id: string, t?: number | null) => sig("replays", { item: id, t: t ?? null }),
};

/** Where a view lives now, for an old /ops address. */
export function opsViewHref(view: OpsView): string {
  if (view.view === "issue") return opsHref.issue(view.id);
  if (view.view === "replay") return opsHref.replay(view.id, view.t);
  if (view.view === "tab") return opsHref.tab(view.tab, { source: view.source, app: view.app });
  return withQuery(SIGNALS, { view: "signals" });
}

/** The view a Signals address names (its `sig`, `source`, `app`, `item`, `t`), or null for Signals' own list. */
export function opsViewOf(q: { sig: string | null; source: string | null; app: string | null; item: string | null; t: string | null }): OpsView | null {
  const tab = (OPS_TABS as readonly string[]).includes(q.sig ?? "") ? (q.sig as OpsTab) : null;
  if (!tab) return null;
  if (q.item && tab === "issues") return { view: "issue", id: q.item };
  const t = Number(q.t);
  if (q.item && tab === "replays") return { view: "replay", id: q.item, t: q.t != null && Number.isFinite(t) && t >= 0 ? t : null };
  return { view: "tab", tab, source: q.source, app: q.app };
}

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
  const q = new URLSearchParams(query ?? "");
  const v = pathname.startsWith("/ops") ? parseOpsPath(pathname, query ?? "") : opsViewOf({ sig: q.get("sig"), source: q.get("source"), app: q.get("app"), item: q.get("item"), t: q.get("t") }) ?? { view: "not-found" as const, path };
  if (v.view === "issue") return v.id;
  if (v.view === "replay") return v.id;
  if (v.view === "tab") return `Signals · ${OPS_TAB_LABEL[v.tab]}`;
  return "Signals";
}
