// Every Ops address, both ways. Ops is its own area at /ops: the home
// (/ops, what is wrong right now), a tab per kind (/ops/<tab>), and the
// detail pages (/ops/issues/eg-N, /ops/replays/rp-N, /ops/metrics/mw-N).
// opsHref builds every link, parseOpsPath reads one back, and opsViewOf reads
// the older Flows address (/flows?view=signals&sig=<tab>), which redirects to
// the same view here (opsViewHref). This file is the only place that knows the
// addresses. Pure: no React, no store.

import { parseReplayT, replayTParam } from "@codecast/shared/replay";

export const OPS_TABS = ["timeline", "issues", "replays", "metrics", "apps"] as const;
export type OpsTab = (typeof OPS_TABS)[number];

export const OPS_TAB_LABEL: Record<OpsTab, string> = {
  timeline: "Timeline",
  issues: "Issues",
  replays: "Replays",
  metrics: "Metrics",
  apps: "Apps",
};

/** The home's filters: one per kind of thing that can be wrong (opsHomeModel ATTENTION_FILTERS). */
export const OPS_HOME_SHOWS = ["alerting", "check", "regressed", "escalating", "new", "firing", "errors", "reader", "erroring", "sources", "degraded", "unassigned", "snoozed"] as const;
export type OpsHomeShow = (typeof OPS_HOME_SHOWS)[number];

export type OpsView =
  | { view: "home"; source: string | null; show: OpsHomeShow | null }
  | { view: "tab"; tab: OpsTab; source: string | null; app: string | null }
  | { view: "issue"; id: string }
  | { view: "replay"; id: string; t: number | null; /** A bare number read as ms, as links before seconds wrote it: the replay page takes it when `t` runs past the recording. */ t_alt?: number }
  | { view: "metric"; id: string }
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

/** Whether a path (with or without a query) is an Ops view: /ops and under it, or an old source view under Signals. */
export function isOpsPath(path: string | null | undefined): boolean {
  return !!path && (/^\/ops(?:[/?#]|$)/.test(path) || (/^\/flows\?/.test(path) && /[?&]sig=/.test(path)));
}

export const OPS_HOME = "/ops";

/** Older names a link may still carry: `spiking` is the Escalating filter. */
const SHOW_ALIAS: Record<string, OpsHomeShow> = { spiking: "escalating" };
const asShow = (s: string | null | undefined): OpsHomeShow | null => SHOW_ALIAS[s ?? ""] ?? ((OPS_HOME_SHOWS as readonly string[]).includes(s ?? "") ? (s as OpsHomeShow) : null);

/** Every link into Ops. */
export const opsHref = {
  home: (opts: { source?: string | null; show?: OpsHomeShow | null } = {}) => withQuery(OPS_HOME, { source: opts.source, show: opts.show }),
  tab: (tab: OpsTab, opts: { source?: string | null; app?: string | null } = {}) => withQuery(`${OPS_HOME}/${tab}`, { source: opts.source, app: opts.app }),
  /** The Issues list on one lane (issuesModel LaneFilter), as the home's issue tiles open it. */
  issues: (opts: { source?: string | null; lane?: string | null; /** Only the issues nobody is on (issueQuery's nobody). */ nobody?: boolean } = {}) => withQuery(`${OPS_HOME}/issues`, { source: opts.source, lane: opts.lane, show: opts.nobody ? "nobody:1" : null }),
  issue: (id: string) => `${OPS_HOME}/issues/${enc(id)}`,
  /** `t` is the scrubber position in ms from the start of the recording; the address carries it in seconds, as PostHog's and Sentry's do. */
  replay: (id: string, t?: number | null) => withQuery(`${OPS_HOME}/replays/${enc(id)}`, { t: t == null ? null : replayTParam(t) }),
  /** One metric watch (mw-N). */
  metric: (id: string) => `${OPS_HOME}/metrics/${enc(id)}`,
};

/** The address of a view. */
export function opsViewHref(view: OpsView): string {
  if (view.view === "home") return opsHref.home({ source: view.source, show: view.show });
  if (view.view === "issue") return opsHref.issue(view.id);
  if (view.view === "replay") return opsHref.replay(view.id, view.t);
  if (view.view === "metric") return opsHref.metric(view.id);
  if (view.view === "tab") return opsHref.tab(view.tab, { source: view.source, app: view.app });
  return OPS_HOME;
}

function replayView(id: string, raw: string | null): OpsView {
  const t = parseReplayT(raw);
  return { view: "replay", id, t: t?.t ?? null, ...(t?.alt !== undefined ? { t_alt: t.alt } : {}) };
}

/** The view an old Signals address names (its `sig`, `source`, `app`, `item`, `t`), or null for Signals' own list. */
export function opsViewOf(q: { sig: string | null; source: string | null; app: string | null; item: string | null; t: string | null }): OpsView | null {
  const tab = (OPS_TABS as readonly string[]).includes(q.sig ?? "") ? (q.sig as OpsTab) : null;
  if (!tab) return null;
  if (q.item && tab === "issues") return { view: "issue", id: q.item };
  if (q.item && tab === "replays") return replayView(q.item, q.t);
  if (q.item && tab === "metrics") return { view: "metric", id: q.item };
  return { view: "tab", tab, source: q.source, app: q.app };
}

export function parseOpsPath(pathname: string | null | undefined, query = ""): OpsView {
  const path = (pathname ?? "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/ops";
  const q = new URLSearchParams(query);
  const segs = path.split("/").filter(Boolean);
  if (segs[0] !== "ops") return { view: "not-found", path };
  const [, first, second, ...rest] = segs;
  if (!first) return { view: "home", source: q.get("source"), show: asShow(q.get("show")) };
  if (rest.length) return { view: "not-found", path };
  if (first === "issues" && second) {
    const id = dec(second);
    return id ? { view: "issue", id } : { view: "not-found", path };
  }
  if (first === "replays" && second) {
    const id = dec(second);
    return id ? replayView(id, q.get("t")) : { view: "not-found", path };
  }
  if (first === "metrics" && second) {
    const id = dec(second);
    return id ? { view: "metric", id } : { view: "not-found", path };
  }
  if (second) return { view: "not-found", path };
  if ((OPS_TABS as readonly string[]).includes(first)) return { view: "tab", tab: first as OpsTab, source: q.get("source"), app: q.get("app") };
  return { view: "not-found", path };
}

/** The tab a view sits under: an issue under Issues, a replay under Replays, a watch under Metrics. Null on the home. */
export function opsViewTab(view: OpsView): OpsTab | null {
  if (view.view === "tab") return view.tab;
  if (view.view === "issue") return "issues";
  if (view.view === "replay") return "replays";
  if (view.view === "metric") return "metrics";
  return null;
}

/** The source filter a view carries (home and tabs). */
export function opsViewSource(view: OpsView): string | null {
  return view.view === "tab" || view.view === "home" ? view.source : null;
}

/** The detail id a view names (an issue, a replay, a watch). */
export function opsViewItem(view: OpsView): string | null {
  return view.view === "issue" || view.view === "replay" || view.view === "metric" ? view.id : null;
}

/**
 * One level up the crumbs (Ops / source / tab / item): an item goes to its
 * tab, an app to its tab, a tab to its source's overview (or the home), a
 * home filter to the same home unfiltered, a source's overview to the home.
 * Null on the bare home.
 */
export function opsUpHref(view: OpsView): string | null {
  const tab = opsViewTab(view);
  if (opsViewItem(view) && tab) return opsHref.tab(tab);
  if (view.view === "tab") return view.app ? opsHref.tab(view.tab, { source: view.source }) : opsHref.home({ source: view.source });
  if (view.view === "home") return view.show ? opsHref.home({ source: view.source }) : view.source ? opsHref.home() : null;
  if (view.view === "not-found") return opsHref.home();
  return null;
}

/** The label a browser tab or a recent visit wears for an Ops address: the item, its tab, then Ops. */
export function opsTabLabel(path: string): string {
  const [pathname, query] = path.split("?");
  const q = new URLSearchParams(query ?? "");
  const v = pathname.startsWith("/ops") ? parseOpsPath(pathname, query ?? "") : opsViewOf({ sig: q.get("sig"), source: q.get("source"), app: q.get("app"), item: q.get("item"), t: q.get("t") }) ?? { view: "not-found" as const, path };
  const tab = opsViewTab(v);
  return [opsViewItem(v), tab ? OPS_TAB_LABEL[tab] : null, "Ops"].filter(Boolean).join(" · ");
}

const OPS_REF = /^(eg|mw|rp|src)-(\d+)$/i;

/** Where a typed Ops ref opens, or null when the text is not one. */
export function opsRefHref(text: string): { ref: string; kind: "issue" | "watch" | "replay" | "source"; href: string } | null {
  const m = OPS_REF.exec(text.trim());
  if (!m) return null;
  const ref = `${m[1].toLowerCase()}-${m[2]}`;
  const p = m[1].toLowerCase();
  if (p === "eg") return { ref, kind: "issue", href: opsHref.issue(ref) };
  if (p === "mw") return { ref, kind: "watch", href: opsHref.metric(ref) };
  if (p === "rp") return { ref, kind: "replay", href: opsHref.replay(ref) };
  return { ref, kind: "source", href: opsHref.home({ source: ref }) };
}

/**
 * Where connecting a provider starts: the sources settings with that kind's
 * add form open (`?add=`), or the integrations page for GitHub, whose CI
 * arrives through the GitHub connection rather than a source form.
 */
export function sourceConnectHref(provider: "sdk" | "http" | "app" | "sentry" | "posthog" | "github"): string {
  return provider === "github" ? "/settings/integrations" : `/settings/integrations?add=${provider}#product-sources`;
}
