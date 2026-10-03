// Every piece of the Changes view lives in the query string (spec 6.3), so a
// link pasted in team chat lands on the same view. Parse and serialize are
// pure; the hook reads the tab's params and writes through the router, with a
// push for a change of day or week and a replace for everything else.
import { useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isoWeekOf, weekDates, weekMonday } from "@codecast/shared/changes";
import { addDays } from "@codecast/convex/convex/lib/teamDay";
import { parseDay } from "../../lib/changesDay";

export type ChangesUrl = {
  repo?: string;
  /** The viewed day, YYYY-MM-DD. Absent means today. Kept in week mode, as the day a return to day mode lands on. */
  d?: string;
  /** Week mode, `2026-W40`. */
  w?: string;
  areas: string[];
  /** A person's key (personKey: a lowercased name), or a session owner's user id from an older link. */
  person?: string;
  branches: "main" | "all";
  risk: boolean;
  /** Only stories waiting behind the latest ship of their surface. */
  waiting: boolean;
  /** A live tile's surface: only its areas. */
  surface?: string;
  q?: string;
  /** The story whose evidence drawer is open. */
  story?: string;
};

export const EMPTY_URL: ChangesUrl = { areas: [], branches: "main", risk: false, waiting: false };

const text = (v: string | null) => {
  const t = v?.trim();
  return t ? t : undefined;
};

export function parseChangesUrl(params: URLSearchParams): ChangesUrl {
  const d = text(params.get("d"));
  const w = text(params.get("w"));
  return {
    repo: text(params.get("repo")),
    d: d && parseDay(d) ? d : undefined,
    w: w && weekMonday(w) ? w : undefined,
    areas: [...new Set((params.get("area") ?? "").split(",").map((a) => a.trim()).filter(Boolean))].sort(),
    person: text(params.get("person")),
    branches: params.get("branches") === "all" ? "all" : "main",
    risk: params.get("risk") === "1",
    waiting: params.get("waiting") === "1",
    surface: text(params.get("surface")),
    q: text(params.get("q")),
    story: text(params.get("story")),
  };
}

/** The query string for a view, keys in a fixed order, defaults left out. Empty for the default view. */
export function serializeChangesUrl(s: ChangesUrl): string {
  const p = new URLSearchParams();
  if (s.repo) p.set("repo", s.repo);
  if (s.d) p.set("d", s.d);
  if (s.w) p.set("w", s.w);
  if (s.areas.length) p.set("area", [...s.areas].sort().join(","));
  if (s.person) p.set("person", s.person);
  if (s.branches === "all") p.set("branches", "all");
  if (s.risk) p.set("risk", "1");
  if (s.waiting) p.set("waiting", "1");
  if (s.surface) p.set("surface", s.surface);
  if (s.q) p.set("q", s.q);
  if (s.story) p.set("story", s.story);
  const qs = p.toString().replace(/%2C/gi, ",").replace(/%2F/gi, "/");
  return qs ? `?${qs}` : "";
}

export function changesHref(s: ChangesUrl): string {
  return `/changes${serializeChangesUrl(s)}`;
}

/** Whether any filter narrows the stories (repo, day and branches are the view, not filters). */
export function hasFilters(s: ChangesUrl): boolean {
  return s.areas.length > 0 || !!s.person || s.risk || s.waiting || !!s.surface || !!s.q;
}

/** The view with an area added to the area filter, or taken out of it. */
export function toggleArea(s: ChangesUrl, area: string): ChangesUrl {
  return { ...s, areas: s.areas.includes(area) ? s.areas.filter((a) => a !== area) : [...s.areas, area] };
}

export function clearFilters(s: ChangesUrl): ChangesUrl {
  return { ...s, areas: [], person: undefined, risk: false, waiting: false, surface: undefined, q: undefined };
}

// ── ISO weeks ────────────────────────────────────────────────────────────

// One implementation, shared with the server's week build.
export { isoWeekOf, weekMonday } from "@codecast/shared/changes";

/** The seven days Monday to Sunday of the week a day falls in. */
export function weekDaysOf(ymd: string): string[] {
  return weekDates(isoWeekOf(ymd))!;
}

// ── Travel ───────────────────────────────────────────────────────────────

/**
 * The view one step earlier or later: a week in week mode, else a day. Never
 * past today, and the open story closes. Pure over the view it is given, so
 * two quick presses of `[` move two days.
 */
export function stepView(s: ChangesUrl, delta: number, today: string): ChangesUrl {
  const monday = s.w ? weekMonday(s.w) : null;
  if (monday) {
    const next = addDays(monday, delta * 7);
    return next > today ? s : { ...s, w: isoWeekOf(next), story: undefined };
  }
  const from = s.d && s.d <= today ? s.d : today;
  const next = addDays(from, delta);
  return { ...s, d: next >= today ? undefined : next, story: undefined };
}

// ── The hook ─────────────────────────────────────────────────────────────

/** Write a patch, or a function of the live view. Returns whether the view changed. */
export type SetChangesUrl = (patch: Partial<ChangesUrl> | ((s: ChangesUrl) => ChangesUrl), mode?: "push" | "replace") => boolean;

export function useChangesUrlState(): { url: ChangesUrl; setUrl: SetChangesUrl } {
  const params = useSearchParams();
  const router = useRouter();
  const key = params.toString();
  // The string stands in for the params object, which is a new ref each render.
  const url = useMemo(() => parseChangesUrl(new URLSearchParams(key)), [key]);
  // The view as last written. The router commits a write a render later, so a
  // second write in the same tick builds on this, not on the view that was on
  // screen when the handler was made. It follows the router whenever the
  // query string changes (Back, a pasted link, a write landing).
  const live = useRef({ key, url });
  if (live.current.key !== key) live.current = { key, url };
  const setUrl = useCallback<SetChangesUrl>((patch, mode = "replace") => {
    const current = live.current.url;
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
    const href = changesHref(next);
    if (href === changesHref(current)) return false;
    live.current = { key: live.current.key, url: next };
    if (mode === "push") router.push(href);
    else router.replace(href);
    return true;
  }, [router]);
  return { url, setUrl };
}
