// Every piece of the Changes view lives in the query string (spec 6.3), so a
// link pasted in team chat lands on the same view. Parse and serialize are
// pure; the hook reads the tab's params and writes through the router, with a
// push for a change of day or week and a replace for everything else.
import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isoWeekOf, weekDates, weekMonday } from "@codecast/shared/changes";
import { parseDay } from "../../lib/changesDay";

export type ChangesUrl = {
  repo?: string;
  /** The viewed day, YYYY-MM-DD. Absent means today. Kept in week mode, as the day a return to day mode lands on. */
  d?: string;
  /** Week mode, `2026-W40`. */
  w?: string;
  areas: string[];
  /** A commit author's name or a session owner's user id. */
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

// ── The hook ─────────────────────────────────────────────────────────────

export type SetChangesUrl = (patch: Partial<ChangesUrl> | ((s: ChangesUrl) => ChangesUrl), mode?: "push" | "replace") => void;

export function useChangesUrlState(): { url: ChangesUrl; setUrl: SetChangesUrl } {
  const params = useSearchParams();
  const router = useRouter();
  const key = params.toString();
  // The string stands in for the params object, which is a new ref each render.
  const url = useMemo(() => parseChangesUrl(new URLSearchParams(key)), [key]);
  const setUrl = useCallback<SetChangesUrl>((patch, mode = "replace") => {
    const next = typeof patch === "function" ? patch(url) : { ...url, ...patch };
    const href = changesHref(next);
    if (href === changesHref(url)) return;
    if (mode === "push") router.push(href);
    else router.replace(href);
  }, [url, router]);
  return { url, setUrl };
}
