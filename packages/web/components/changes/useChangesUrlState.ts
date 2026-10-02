// Every piece of the Changes view lives in the query string (spec 6.3), so a
// link pasted in team chat lands on the same view. Parse and serialize are
// pure; the hook reads the tab's params and writes through the router, with a
// push for a change of day or week and a replace for everything else.
import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addDays } from "@codecast/convex/convex/lib/teamDay";

export type ChangesUrl = {
  repo?: string;
  /** The viewed day, YYYY-MM-DD. Absent means today. */
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = /^(\d{4})-W(\d{2})$/;

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
    d: d && DAY.test(d) ? d : undefined,
    w: w && WEEK.test(w) ? w : undefined,
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
  if (s.w) p.set("w", s.w);
  else if (s.d) p.set("d", s.d);
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

const utc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** The ISO week a day falls in: `2026-W40`. */
export function isoWeekOf(ymd: string): string {
  const d = utc(ymd);
  const weekday = d.getUTCDay() || 7;
  // The week belongs to the year its Thursday is in.
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The Monday of an ISO week, YYYY-MM-DD, or null when the week is malformed. */
export function weekMonday(week: string): string | null {
  const m = WEEK.exec(week);
  if (!m) return null;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = addDays(jan4.toISOString().slice(0, 10), -((jan4.getUTCDay() || 7) - 1));
  return addDays(monday, (Number(m[2]) - 1) * 7);
}

/** The seven days Monday to Sunday of the week a day falls in. */
export function weekDaysOf(ymd: string): string[] {
  const monday = weekMonday(isoWeekOf(ymd))!;
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
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
