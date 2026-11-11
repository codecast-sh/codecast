// The dashboard's filter as the URL holds it (`?f.day=30d&f.person=ada`), so
// a filtered view is a link to send, and how to change it.
import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { dashboard } from "@codecast/shared/artifacts";

const todayUtc = (now: number) => new Date(now).toISOString().slice(0, 10);

export const DATE_PRESETS = [
  { spec: "7d", label: "Last 7 days" },
  { spec: "14d", label: "Last 14 days" },
  { spec: "30d", label: "Last 30 days" },
  { spec: "90d", label: "Last 90 days" },
] as const;

/** A date filter as a person says it: "Last 7 days", "Nov 3 – Nov 9". */
export function dateLabel(spec: string): string {
  const preset = DATE_PRESETS.find((p) => p.spec === spec);
  if (preset) return preset.label;
  const rel = spec.match(/^(\d+)d$/);
  if (rel) return `Last ${rel[1]} days`;
  const m = spec.match(/^(\d{4}-\d\d-\d\d)?\.\.(\d{4}-\d\d-\d\d)?$/);
  if (!m) return "All dates";
  const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return m[1] && m[2] ? `${short(m[1])} – ${short(m[2])}` : m[1] ? `From ${short(m[1])}` : `Until ${short(m[2]!)}`;
}

/** The URL's filters in words, for a picture of the dashboard that has no filter bar: "Last 7 days · Jason Benn". */
export function filterWords(search: string): string[] {
  const params = new URLSearchParams(search);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of params.keys()) {
    if (!k.startsWith("f.") || seen.has(k)) continue;
    seen.add(k);
    const col = k.slice(2);
    const vals = params.getAll(k).filter(Boolean);
    if (!vals.length) continue;
    out.push(col === "day" || col === "date" ? dateLabel(vals[0]) : vals.join(" or "));
  }
  return out;
}

export function useDashboardScope(now: number) {
  const params = useSearchParams();
  const router = useRouter();
  const sig = params.toString();
  const today = todayUtc(now);
  const scope = useMemo(() => dashboard.scopeFromParams(new URLSearchParams(sig).entries(), today), [sig, today]);
  const value = useCallback((column: string) => new URLSearchParams(sig).get(`f.${column}`) ?? "", [sig]);
  /** A category filter's picks, one param each (`f.person=ada&f.person=bo`), so a name with a comma survives and nothing is encoded twice. */
  const values = useCallback((column: string) => new URLSearchParams(sig).getAll(`f.${column}`).filter(Boolean), [sig]);
  const set = useCallback(
    (column: string, v: string | readonly string[] | null) => {
      const next = new URLSearchParams(window.location.search);
      next.delete(`f.${column}`);
      for (const one of typeof v === "string" ? [v] : (v ?? [])) if (one) next.append(`f.${column}`, one);
      const q = next.toString();
      router.replace(`${window.location.pathname}${q ? `?${q}` : ""}`, { scroll: false });
    },
    [router],
  );
  const clear = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    for (const k of [...next.keys()]) if (k.startsWith("f.")) next.delete(k);
    const q = next.toString();
    router.replace(`${window.location.pathname}${q ? `?${q}` : ""}`, { scroll: false });
  }, [router]);
  return { scope, value, values, set, clear };
}

