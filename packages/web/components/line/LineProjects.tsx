"use client";
// The project a line surface is filtered to, and what waits on a person in a
// project's line. The line is one app over the process (line-workspace.md
// LW1); a project is a filter on it, held in the URL's `?project=`.
import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ALL_PROJECTS, NO_PROJECT, type LineProject, type RollupRow } from "../../lib/lineFlow";
import { lineProjectParam } from "../../lib/line/lineStations";

/** The URL names a project by its short id (or id), "none" or "all". */
const paramOf = (key: string, projects: LineProject[]) => {
  const p = key === ALL_PROJECTS || key === NO_PROJECT ? null : projects.find((x) => x._id === key);
  return p ? lineProjectParam(p) : key;
};

/**
 * The selected project: the `?project=` the URL names, else every project. A
 * ref the viewer cannot see falls back to every project rather than an empty
 * page. `fixed` pins it (a project's own page): the URL is not read and
 * nothing switches it.
 */
export function useLineProject(_rollup: RollupRow[], projects: LineProject[], fixed?: string | null) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const asked = search?.get("project") ?? null;
  const key = useMemo(() => {
    if (fixed) return fixed;
    if (asked === ALL_PROJECTS || asked === NO_PROJECT) return asked;
    const named = asked ? projects.find((p) => p.short_id === asked || p._id === asked) : undefined;
    return named ? named._id : ALL_PROJECTS;
  }, [fixed, asked, projects]);
  const select = useCallback((next: string) => {
    if (fixed) return;
    const params = new URLSearchParams(search?.toString() ?? "");
    params.set("project", paramOf(next, projects));
    router.replace(`${pathname ?? "/line"}?${params.toString()}`, { scroll: false });
  }, [fixed, router, pathname, search, projects]);
  const param = paramOf(key, projects);
  return { key, select, param, href: `${fixed ? "/line" : pathname ?? "/line"}?project=${encodeURIComponent(param)}` };
}

/** What waits on a person in a project's line: finished fixes to decide on, fixes that shipped past an
 *  unanswered card, and the waiting problems that hold for a review or a person's answer (lineFlow notReadyReasons). */
export type WaitKind = "decisions" | "unapproved" | "reviews" | "questions";
export type WaitsOnYou = Record<WaitKind, number> & { total: number };

export function waitsOnYou(r: Pick<RollupRow, "awaiting" | "notReady"> & { unapproved?: number }): WaitsOnYou {
  const of = (key: string) => r.notReady.find((x) => x.key === key)?.count ?? 0;
  const reviews = of("review");
  const questions = of("context");
  const unapproved = r.unapproved ?? 0;
  return { decisions: r.awaiting, unapproved, reviews, questions, total: r.awaiting + unapproved + reviews + questions };
}
