// The Modern Activity page's model (components/activity/ModernActivityPage):
// pure functions from the feed's rows and the store's outcome rows to what the
// page draws. No React, no store: the hooks beside this file read the store
// and hand the rows in, so every rule here is testable on plain data.
//
// The page answers four questions, and each has its function here:
//   who is working on what right now  → nowStrip
//   what got done since I last looked → groupActivity (day, then person or project)
//   what is stuck or waiting          → needsList
//   open the thing                    → every item and outcome carries its link
import type { Conversation } from "../../lib/conversationRow";
import type { ExternalEventRecord } from "../../lib/externalEventRecord";
import { prPath, shepherdStyle, type ExternalEventAccent } from "../../lib/externalEvents";
import type { SessionStatus } from "../../lib/sessionStatus";
import { extractWorkspace, formatDate } from "../feed/activityFeedFormat";

export type ActivityActor = { id: string; name: string; image: string | null };

/** A pull request a session touched, in the state it is in now. */
export type ActivityPr = {
  key: string;
  repository: string;
  number: number;
  title: string;
  /** What the chip says after the number: "merged", "open", a shepherd state. */
  label: string;
  accent: ExternalEventAccent;
  merged: boolean;
  href: string | null;
  at: number;
};

export type ActivityTask = { id: string; shortId: string; title: string; done: boolean; at: number };

export type ActivityDecision = {
  id: string;
  shortId: string | null;
  question: string;
  pending: boolean;
  /** Asked of the viewer: they can answer it. */
  askedOfViewer: boolean;
  at: number;
};

export type ActivityOutcomes = { prs: ActivityPr[]; commits: number; tasks: ActivityTask[]; decisions: ActivityDecision[] };

export const NO_OUTCOMES: ActivityOutcomes = { prs: [], commits: 0, tasks: [], decisions: [] };

export type ActivityItem = {
  id: string;
  title: string;
  /** The one line about the work: the pinned state line or the summary, never a prompt. */
  line: string;
  /** Why the state is what it is ("API error", "Decision"), when there is one. */
  reason: string | null;
  status: SessionStatus;
  actor: ActivityActor;
  project: string | null;
  at: number;
  isOwn: boolean;
  /** One of the viewer's own sessions on the team feed that the team cannot open. */
  hiddenFromTeam: boolean;
  /** Waits on a person: Needs you, Error, or a pending decision. */
  needs: boolean;
  outcomes: ActivityOutcomes;
  conv: Conversation;
  /** A digest of everything the row draws: an equal digest keeps the old item. */
  sig: string;
};

// ── outcomes ────────────────────────────────────────────────────────────────

type PrStateWord = "open" | "merged" | "closed" | "draft";

// The kinds that move a pull request's state. Every other PR kind (a review,
// a check, a push to it) says the session touched it, not where it stands.
const PR_STATE_OF_KIND: Record<string, PrStateWord> = {
  pr_opened: "open",
  pr_reopened: "open",
  pr_ready_for_review: "open",
  pr_draft: "draft",
  pr_merged: "merged",
  pr_closed: "closed",
};

const PR_STATE_LOOK: Record<PrStateWord, { label: string; accent: ExternalEventAccent }> = {
  open: { label: "open", accent: "green" },
  merged: { label: "merged", accent: "violet" },
  closed: { label: "closed", accent: "muted" },
  draft: { label: "draft", accent: "muted" },
};

/** One pull request across every event the store holds for it: its state is
 *  the newest state-moving event's, whichever session (or none) it came from. */
export type PrThread = ActivityPr & {
  /** The sessions that touched it. */
  convIds: Set<string>;
  /** Who moved it last, for a PR no listed session touched. */
  actor: ActivityActor | null;
  /** The repository's last segment, the name the project filter uses. */
  repoName: string;
  /** When its state last moved: the day a loose PR files under. */
  stateAt: number;
};

const prKey = (repository: string, number: number) => `${repository}#${number}`;

/** The chip's fields of a thread, without the bookkeeping. */
export function plainPr(pr: ActivityPr): ActivityPr {
  return { key: pr.key, repository: pr.repository, number: pr.number, title: pr.title, label: pr.label, accent: pr.accent, merged: pr.merged, href: pr.href, at: pr.at };
}

export function prThreads(events: readonly ExternalEventRecord[]): Map<string, PrThread> {
  const out = new Map<string, PrThread & { stateEventAt: number }>();
  for (const e of events) {
    if (e.pr_number === undefined || !e.repository) continue;
    const key = prKey(e.repository, e.pr_number);
    const at = e.created_at ?? 0;
    let t = out.get(key);
    if (!t) {
      t = {
        key,
        repository: e.repository,
        number: e.pr_number,
        title: "",
        ...PR_STATE_LOOK.open,
        merged: false,
        href: prPath({ repository: e.repository, number: e.pr_number }),
        at,
        convIds: new Set(),
        actor: null,
        repoName: e.repository.split("/").filter(Boolean).pop() ?? e.repository,
        stateAt: at,
        stateEventAt: -1,
      };
      out.set(key, t);
    }
    if (e.conversation_id) t.convIds.add(e.conversation_id);
    if (at > t.at) t.at = at;
    const state = PR_STATE_OF_KIND[e.kind ?? ""];
    if (state && at >= t.stateEventAt) {
      t.stateEventAt = at;
      t.stateAt = at;
      t.label = PR_STATE_LOOK[state].label;
      t.accent = PR_STATE_LOOK[state].accent;
      t.merged = state === "merged";
      if (e.title) t.title = e.title;
      const who = e.actor_user_id || (e.actor_login ? `gh:${e.actor_login}` : "");
      t.actor = who ? { id: who, name: e.actor_login ?? "", image: e.actor_avatar_url ?? null } : t.actor;
    }
  }
  return out;
}

/** A PR from the session's own row (the shepherd's live state), which outranks
 *  what the events last said. */
export function prFromStatus(pr: { repository: string; number: number; title?: string; state: string; at: number }): ActivityPr {
  const look = shepherdStyle(pr.state);
  return {
    key: prKey(pr.repository, pr.number),
    repository: pr.repository,
    number: pr.number,
    title: pr.title ?? "",
    label: look.label,
    accent: look.accent,
    merged: pr.state === "merged",
    href: prPath({ repository: pr.repository, number: pr.number }),
    at: pr.at,
  };
}

export type TaskRowLike = {
  _id: string;
  short_id?: string;
  title?: string;
  status?: string;
  closed_at?: number;
  updated_at?: number;
  conversation_ids?: string[];
  created_from_conversation?: string;
};

export type DecisionRowLike = {
  _id: string;
  short_id?: string;
  conversation_id?: string;
  question?: string;
  status?: string;
  asked_user_ids?: string[];
  resolved_at?: number;
  created_at?: number;
};

/** Every session's outcomes, by conversation id. */
export function indexOutcomes(src: {
  events: readonly ExternalEventRecord[];
  prs: Map<string, PrThread>;
  tasks: readonly TaskRowLike[];
  decisions: readonly DecisionRowLike[];
  viewerId: string | null;
}): Map<string, ActivityOutcomes> {
  const out = new Map<string, { prs: Map<string, ActivityPr>; shas: Set<string>; pushed: number; tasks: ActivityTask[]; decisions: ActivityDecision[] }>();
  const slot = (id: string) => {
    let s = out.get(id);
    if (!s) { s = { prs: new Map(), shas: new Set(), pushed: 0, tasks: [], decisions: [] }; out.set(id, s); }
    return s;
  };
  for (const pr of src.prs.values()) {
    if (pr.convIds.size === 0) continue;
    const plain = plainPr(pr);
    for (const id of pr.convIds) slot(id).prs.set(pr.key, plain);
  }
  for (const e of src.events) {
    if (!e.conversation_id) continue;
    if (e.kind === "commit" || e.kind === "amend" || e.kind === "cherry_pick") {
      if (e.sha) slot(e.conversation_id).shas.add(e.sha);
    } else if (e.kind === "push") {
      slot(e.conversation_id).pushed += Number(e.meta?.commits_count) || 0;
    }
  }
  for (const t of src.tasks) {
    if (!t.short_id || t.status === "dropped") continue;
    const ids = new Set(t.conversation_ids ?? []);
    if (t.created_from_conversation) ids.add(t.created_from_conversation);
    if (ids.size === 0) continue;
    const done = t.status === "done";
    const task: ActivityTask = { id: t._id, shortId: t.short_id, title: t.title ?? "", done, at: (done ? t.closed_at : undefined) ?? t.updated_at ?? 0 };
    for (const id of ids) slot(id).tasks.push(task);
  }
  for (const d of src.decisions) {
    if (!d.conversation_id || (d.status !== "pending" && d.status !== "answered")) continue;
    const pending = d.status === "pending";
    const askedOfViewer = pending && !!src.viewerId && (!d.asked_user_ids || d.asked_user_ids.some((u) => String(u) === src.viewerId));
    slot(d.conversation_id).decisions.push({
      id: d._id,
      shortId: d.short_id ?? null,
      question: d.question ?? "",
      pending,
      askedOfViewer,
      at: (pending ? d.created_at : d.resolved_at ?? d.created_at) ?? 0,
    });
  }
  const result = new Map<string, ActivityOutcomes>();
  for (const [id, s] of out) {
    result.set(id, {
      prs: [...s.prs.values()].sort(byOutcomeWeight),
      commits: Math.max(s.shas.size, s.pushed),
      tasks: s.tasks.sort((a, b) => Number(b.done) - Number(a.done) || b.at - a.at),
      decisions: s.decisions.sort((a, b) => Number(b.pending) - Number(a.pending) || b.at - a.at),
    });
  }
  return result;
}

/** Merged first, then open work, then the rest; newest first inside each. */
function byOutcomeWeight(a: ActivityPr, b: ActivityPr): number {
  const w = (p: ActivityPr) => (p.merged ? 0 : p.accent === "muted" ? 2 : 1);
  return w(a) - w(b) || b.at - a.at;
}

/** A session's outcomes with its own row's live PR state laid over the events'. */
export function withLivePr(outcomes: ActivityOutcomes | undefined, live: ActivityPr | null): ActivityOutcomes {
  const base = outcomes ?? NO_OUTCOMES;
  if (!live) return base;
  const prs = [live, ...base.prs.filter((p) => p.key !== live.key)].sort(byOutcomeWeight);
  return { ...base, prs };
}

/** The PRs no listed session touched: the team's work outside the feed. */
export function loosePrs(prs: Map<string, PrThread>, listedIds: ReadonlySet<string>): PrThread[] {
  const out: PrThread[] = [];
  for (const pr of prs.values()) {
    if (!pr.actor) continue;
    let listed = false;
    for (const id of pr.convIds) if (listedIds.has(id)) { listed = true; break; }
    if (!listed) out.push(pr);
  }
  return out.sort((a, b) => b.stateAt - a.stateAt);
}

// ── items ───────────────────────────────────────────────────────────────────

/** The row's branch: listConversations and the inbox mapping both carry it,
 *  though the shared Conversation type does not name it. */
export function branchOf(conv: Conversation): string | null {
  return (conv as Conversation & { git_branch?: string | null }).git_branch ?? null;
}

export function outcomesSig(o: ActivityOutcomes): string {
  return [
    o.prs.map((p) => `${p.key}:${p.label}`).join(","),
    o.commits,
    o.tasks.map((t) => `${t.shortId}:${t.done ? 1 : 0}`).join(","),
    o.decisions.map((d) => `${d.id}:${d.pending ? 1 : 0}${d.askedOfViewer ? 1 : 0}`).join(","),
  ].join("|");
}

export function makeItem(input: {
  conv: Conversation;
  status: SessionStatus;
  reason: string | null;
  line: string;
  title: string;
  actor: ActivityActor;
  outcomes: ActivityOutcomes;
  hiddenFromTeam: boolean;
}): ActivityItem {
  const { conv, status, outcomes } = input;
  const needs = status === "needs_you" || status === "error" || outcomes.decisions.some((d) => d.pending);
  const project = extractWorkspace(conv.project_path) ?? extractWorkspace(conv.git_root) ?? null;
  const at = conv.updated_at || conv.started_at || 0;
  const sig = [
    status, input.title, input.line, input.reason ?? "", at, input.actor.id, input.actor.name, input.actor.image ?? "",
    project ?? "", input.hiddenFromTeam ? 1 : 0, conv.message_count ?? 0, conv.subtitle ?? "", branchOf(conv) ?? "",
    outcomesSig(outcomes),
  ].join("\u0001");
  return {
    id: conv._id,
    title: input.title,
    line: input.line,
    reason: input.reason,
    status,
    actor: input.actor,
    project,
    at,
    isOwn: !!conv.is_own,
    hiddenFromTeam: input.hiddenFromTeam,
    needs,
    outcomes,
    conv,
    sig,
  };
}

/** Hand back last pass's item wherever nothing it draws changed, so a memoized
 *  row skips the render. Returns the next cache alongside the items. */
export function keepStableItems(prev: ReadonlyMap<string, ActivityItem>, next: ActivityItem[]): { items: ActivityItem[]; cache: Map<string, ActivityItem> } {
  const cache = new Map<string, ActivityItem>();
  const items = next.map((item) => {
    const old = prev.get(item.id);
    const kept = old && old.sig === item.sig ? old : item;
    cache.set(item.id, kept);
    return kept;
  });
  return { items, cache };
}

// ── filters ─────────────────────────────────────────────────────────────────

export type ActivityFilter = { people: readonly string[]; project: string | null; needs: boolean };

export function filterItems(items: readonly ActivityItem[], f: ActivityFilter): ActivityItem[] {
  if (f.people.length === 0 && !f.project && !f.needs) return items as ActivityItem[];
  const people = new Set(f.people);
  return items.filter((i) => (people.size === 0 || people.has(i.actor.id)) && (!f.project || i.project === f.project) && (!f.needs || i.needs));
}

export function filterLoose(prs: readonly PrThread[], f: ActivityFilter): PrThread[] {
  if (f.needs) return [];
  if (f.people.length === 0 && !f.project) return prs as PrThread[];
  const people = new Set(f.people);
  return prs.filter((p) => (people.size === 0 || (!!p.actor && people.has(p.actor.id))) && (!f.project || p.repoName === f.project));
}

export type PersonFacet = { actor: ActivityActor; sessions: number; live: number };

/** The faces the header offers: everyone in the loaded feed, the ones working
 *  now first, then by how much they did. */
export function peopleFacets(items: readonly ActivityItem[]): PersonFacet[] {
  const map = new Map<string, PersonFacet>();
  for (const i of items) {
    let f = map.get(i.actor.id);
    if (!f) { f = { actor: i.actor, sessions: 0, live: 0 }; map.set(i.actor.id, f); }
    f.sessions += 1;
    if (isLive(i.status)) f.live += 1;
  }
  return [...map.values()].sort((a, b) => b.live - a.live || b.sessions - a.sessions || a.actor.name.localeCompare(b.actor.name));
}

export function projectFacets(items: readonly ActivityItem[]): Array<{ name: string; sessions: number }> {
  const map = new Map<string, number>();
  for (const i of items) if (i.project) map.set(i.project, (map.get(i.project) ?? 0) + 1);
  return [...map.entries()].map(([name, sessions]) => ({ name, sessions })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

// ── the four answers ────────────────────────────────────────────────────────

export const isLive = (s: SessionStatus) => s === "working" || s === "starting";

export type NowPerson = { actor: ActivityActor; items: ActivityItem[] };

/** Who is working right now, and on what: each person with their live sessions. */
export function nowStrip(items: readonly ActivityItem[]): NowPerson[] {
  const map = new Map<string, NowPerson>();
  for (const i of items) {
    if (!isLive(i.status)) continue;
    let p = map.get(i.actor.id);
    if (!p) { p = { actor: i.actor, items: [] }; map.set(i.actor.id, p); }
    p.items.push(i);
  }
  for (const p of map.values()) p.items.sort((a, b) => b.at - a.at);
  return [...map.values()].sort((a, b) => b.items.length - a.items.length || a.actor.name.localeCompare(b.actor.name));
}

const NEEDS_RANK: Partial<Record<SessionStatus, number>> = { error: 0, needs_you: 1 };

/** What waits on someone: failures first, then asks, newest first inside each. */
export function needsList(items: readonly ActivityItem[]): ActivityItem[] {
  return items.filter((i) => i.needs).sort((a, b) => (NEEDS_RANK[a.status] ?? 2) - (NEEDS_RANK[b.status] ?? 2) || b.at - a.at);
}

export type ActivitySummary = { sessions: number; people: number; prsMerged: number; tasksDone: number; since: number | null };

export function summarize(items: readonly ActivityItem[], loose: readonly PrThread[]): ActivitySummary {
  const people = new Set<string>();
  const merged = new Set<string>();
  const done = new Set<string>();
  let since: number | null = null;
  for (const i of items) {
    people.add(i.actor.id);
    for (const p of i.outcomes.prs) if (p.merged) merged.add(p.key);
    for (const t of i.outcomes.tasks) if (t.done) done.add(t.id);
    if (i.at && (since === null || i.at < since)) since = i.at;
  }
  for (const p of loose) if (p.merged) merged.add(p.key);
  return { sessions: items.length, people: people.size, prsMerged: merged.size, tasksDone: done.size, since };
}

// ── grouping ────────────────────────────────────────────────────────────────

export type ActivityGroupBy = "person" | "project";

export type ActivityGroup = {
  key: string;
  label: string;
  /** Person groups: whose. */
  actor: ActivityActor | null;
  /** Project groups: which (null for sessions outside any project). */
  project: string | null;
  items: ActivityItem[];
  /** Every PR the group's work touched or moved, merged first. */
  prs: ActivityPr[];
  tasksDone: ActivityTask[];
  decisionsAnswered: ActivityDecision[];
  at: number;
};

export type ActivityDay = { date: string; label: string; groups: ActivityGroup[]; sessions: number; people: number };

export function dayKeyOf(ts: number, timeZone: string): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone });
}

export const OTHER_PROJECT = "Other";

/** Day, newest first; inside a day one group per person (or project), the
 *  most recently active first; inside a group its sessions newest first. A PR
 *  no listed session touched files under the person who moved it (or its
 *  repository) on the day it moved. */
export function groupActivity(items: readonly ActivityItem[], loose: readonly PrThread[], by: ActivityGroupBy, timeZone: string): ActivityDay[] {
  type Acc = { group: ActivityGroup; prs: Map<string, ActivityPr>; tasks: Map<string, ActivityTask>; decisions: Map<string, ActivityDecision> };
  const days = new Map<string, Map<string, Acc>>();
  const groupOf = (date: string, key: string, init: () => ActivityGroup) => {
    let groups = days.get(date);
    if (!groups) { groups = new Map(); days.set(date, groups); }
    let acc = groups.get(key);
    if (!acc) { acc = { group: init(), prs: new Map(), tasks: new Map(), decisions: new Map() }; groups.set(key, acc); }
    return acc;
  };
  const personGroup = (actor: ActivityActor): ActivityGroup => ({ key: `p:${actor.id}`, label: actor.name, actor, project: null, items: [], prs: [], tasksDone: [], decisionsAnswered: [], at: 0 });
  const projectGroup = (project: string | null): ActivityGroup => ({ key: `r:${project ?? ""}`, label: project ?? OTHER_PROJECT, actor: null, project, items: [], prs: [], tasksDone: [], decisionsAnswered: [], at: 0 });

  for (const item of items) {
    const date = dayKeyOf(item.at || Date.now(), timeZone);
    const acc = by === "person"
      ? groupOf(date, `p:${item.actor.id}`, () => personGroup(item.actor))
      : groupOf(date, `r:${item.project ?? ""}`, () => projectGroup(item.project));
    acc.group.items.push(item);
    if (item.at > acc.group.at) acc.group.at = item.at;
    for (const p of item.outcomes.prs) acc.prs.set(p.key, p);
    for (const t of item.outcomes.tasks) if (t.done) acc.tasks.set(t.id, t);
    for (const d of item.outcomes.decisions) if (!d.pending) acc.decisions.set(d.id, d);
  }
  for (const pr of loose) {
    const date = dayKeyOf(pr.stateAt || pr.at, timeZone);
    const acc = by === "person"
      ? groupOf(date, `p:${pr.actor!.id}`, () => personGroup(pr.actor!))
      : groupOf(date, `r:${pr.repoName}`, () => projectGroup(pr.repoName));
    if (!acc.prs.has(pr.key)) acc.prs.set(pr.key, plainPr(pr));
    if (pr.stateAt > acc.group.at) acc.group.at = pr.stateAt;
  }

  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, groups]) => {
      const list = [...groups.values()].map(({ group, prs, tasks, decisions }) => ({
        ...group,
        items: group.items.sort((a, b) => b.at - a.at),
        prs: [...prs.values()].sort(byOutcomeWeight),
        tasksDone: [...tasks.values()].sort((a, b) => b.at - a.at),
        decisionsAnswered: [...decisions.values()].sort((a, b) => b.at - a.at),
      }));
      list.sort((a, b) => b.at - a.at);
      const people = new Set<string>();
      let sessions = 0;
      for (const g of list) for (const i of g.items) { sessions += 1; people.add(i.actor.id); }
      return { date, label: formatDate(date), groups: list, sessions, people: people.size };
    });
}
