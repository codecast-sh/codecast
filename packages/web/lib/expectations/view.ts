// What the expectations pages derive from a project's row (the-line-model.md
// LM5): the document grouped by area, how often findings break each line,
// the filters a reader narrows it by, the history as one timeline, and the
// overview's order. Pure, so the page and its tests read the same answers.
import type { Expectation, ExpectationCitation } from "@codecast/shared/contracts/expectations";
import type { ExpectationFinding, ExpectationLineUsage, ExpectationProposalView, ExpectationVersionView, ProjectExpectationsRow } from "../../hooks/useSyncProjectExpectations";
import type { ExpectationsOverviewRow } from "../../hooks/useSyncExpectationsOverview";

/** What an expectation is, in the one line every surface opens with. */
export const EXPECTATIONS_ABOUT = "Plain sentences about how the product should behave, each quoted from where someone said it. Findings that judge behavior cite the line they break.";

/** Group lines by the area of the product they concern, in first-seen order. */
export function byArea<T extends { part: string }>(items: T[]): Array<[string, T[]]> {
  const by = new Map<string, T[]>();
  for (const e of items) by.set(e.part, [...(by.get(e.part) ?? []), e]);
  return [...by.entries()];
}

const NO_USAGE: ExpectationLineUsage = { d7: 0, d30: 0, findings: [] };

/** One line's breaks, zero when no finding cited it. */
export const usageOf = (row: Pick<ProjectExpectationsRow, "usage"> | null | undefined, id: string): ExpectationLineUsage => row?.usage?.lines?.[id] ?? NO_USAGE;

/**
 * How a line has fared against findings lately: broken this week, broken in
 * the last 30 days, or never cited in that window.
 */
export type LineHeat = "week" | "month" | "quiet";
export function lineHeat(u: ExpectationLineUsage): LineHeat {
  return u.d7 > 0 ? "week" : u.d30 > 0 ? "month" : "quiet";
}

/** The document's usage at a glance: breaks in the last 7 and 30 days, how many lines were broken and how many never fired. */
export function usageSummary(active: Expectation[], row: Pick<ProjectExpectationsRow, "usage"> | null | undefined) {
  let breaks7 = 0, breaks30 = 0, broken = 0, quiet = 0;
  for (const e of active) {
    const u = usageOf(row, e.id);
    breaks7 += u.d7;
    breaks30 += u.d30;
    if (u.d30 > 0) broken++;
    else quiet++;
  }
  return { breaks7, breaks30, broken, quiet };
}

const normWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * What a finding says beyond the line it breaks: its title, unless the title
 * only restates the line ("Not met: <the line>"), then the opening of its
 * detail, then the title anyway.
 */
export function findingWords(f: Pick<ExpectationFinding, "title" | "detail">, lineText: string): string {
  const rest = normWords(f.title).replace(normWords(lineText), "").replace(/\b(not met|broke|breaks|violat\w*|failed)\b/g, "").trim();
  return rest.length >= 12 || !f.detail ? f.title : f.detail;
}

/** The causes a line's findings opened, most findings first. */
export function findingCauses(findings: ExpectationFinding[]): Array<{ short_id: string; title: string; status: string; count: number }> {
  const by = new Map<string, { short_id: string; title: string; status: string; count: number }>();
  for (const f of findings) {
    if (!f.cause?.short_id) continue;
    const c = by.get(f.cause.short_id) ?? { short_id: f.cause.short_id, title: f.cause.title, status: f.cause.status, count: 0 };
    c.count++;
    by.set(f.cause.short_id, c);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

/** The ways a reader narrows the document. */
export const LINE_FILTERS = ["all", "broken", "quiet", "questions"] as const;
export type LineFilter = (typeof LINE_FILTERS)[number];

export function filterLines(active: Expectation[], row: Pick<ProjectExpectationsRow, "usage"> | null | undefined, filter: LineFilter, query = ""): Expectation[] {
  const q = query.trim().toLowerCase();
  return active.filter((e) => {
    if (q && !`${e.text} ${e.part} ${e.id} ${e.note ?? ""}`.toLowerCase().includes(q)) return false;
    if (filter === "broken") return usageOf(row, e.id).d30 > 0;
    if (filter === "quiet") return usageOf(row, e.id).d30 === 0;
    if (filter === "questions") return !!e.note;
    return true;
  });
}

/** How many lines each filter holds, for the counts beside them. */
export function filterCounts(active: Expectation[], row: Pick<ProjectExpectationsRow, "usage"> | null | undefined): Record<LineFilter, number> {
  return Object.fromEntries(LINE_FILTERS.map((f) => [f, filterLines(active, row, f).length])) as Record<LineFilter, number>;
}

/** Who said a source's words, when the record names them. */
export function sourceSpeaker(row: Pick<ProjectExpectationsRow, "sources"> | null | undefined, c: ExpectationCitation): { who?: string } {
  return row?.sources?.[`${c.kind}:${c.ref}`] ?? {};
}

/** One entry of a document's history, newest first: a version applied, or a proposal closed without one. */
export type HistoryEntry =
  | { kind: "version"; at: number; version: number; summary: string; how: "person" | "auto"; by?: string; proposal?: string; proposedBy?: string; fromSession?: boolean; added: number; changed: number; retired: number; active: number }
  | { kind: "closed"; at: number; status: "dropped" | "retracted"; summary: string; proposal: string; reason?: string };

export function historyEntries(versions: ExpectationVersionView[], proposals: ExpectationProposalView[]): HistoryEntry[] {
  const out: HistoryEntry[] = versions.map((v) => ({
    kind: "version", at: v.applied_at, version: v.version, summary: v.summary, how: v.how, by: v.applied_by,
    proposal: v.proposal, proposedBy: v.proposed_by, fromSession: v.from_session,
    added: v.added ?? 0, changed: v.changed ?? 0, retired: v.retired ?? 0, active: v.active,
  }));
  for (const p of proposals) {
    if ((p.status === "dropped" || p.status === "retracted") && p.short_id) out.push({ kind: "closed", at: p.resolved_at ?? p.created_at, status: p.status, summary: p.summary, proposal: p.short_id, ...(p.retracted_reason ? { reason: p.retracted_reason } : {}) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** How a version landed, in a reader's words. */
export function howApplied(e: Extract<HistoryEntry, { kind: "version" }>): string {
  if (e.how === "auto") return "Applied on its own: every line it added quotes words a person said";
  return `Applied by ${e.by ?? "a teammate"}`;
}

/** What a version changed, as a short phrase: "3 added, 1 retired". */
export function changePhrase(e: { added: number; changed: number; retired: number }): string {
  const parts = [e.added && `${e.added} added`, e.changed && `${e.changed} changed`, e.retired && `${e.retired} retired`].filter(Boolean);
  return parts.length ? parts.join(", ") : "no line changed";
}

/** The open proposals, the ones the page answers first, newest first. */
export const openProposals = (row: Pick<ProjectExpectationsRow, "proposals"> | null | undefined): ExpectationProposalView[] =>
  (row?.proposals ?? []).filter((p) => p.status === "open").sort((a, b) => b.created_at - a.created_at);

/**
 * The overview's order: documents waiting on someone first, then the ones
 * being broken most, then the rest by title; projects with no document after
 * every project that has one.
 */
export function sortOverview(rows: ExpectationsOverviewRow[]): { documents: ExpectationsOverviewRow[]; without: ExpectationsOverviewRow[] } {
  const documents = rows.filter((r) => r.version > 0).sort((a, b) =>
    (b.open_proposals > 0 ? 1 : 0) - (a.open_proposals > 0 ? 1 : 0) || b.breaks30 - a.breaks30 || a.project.title.localeCompare(b.project.title));
  const without = rows.filter((r) => r.version === 0).sort((a, b) => a.project.title.localeCompare(b.project.title));
  return { documents, without };
}

/** A project's Expectations tab, landing on one line when an id is given. */
export function expectationsHref(project: string, id?: string): string {
  return `/projects/${project}?tab=expectations${id ? `#${id}` : ""}`;
}
