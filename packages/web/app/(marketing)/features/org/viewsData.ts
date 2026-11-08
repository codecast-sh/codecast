import { SOL } from "./model";

/*
 * The chart section's illustrative company: every role's sessions, standing
 * line, area status, charter, open work and week, plus the goals and projects
 * the Everything and Goals views join in. Words and thresholds follow the app
 * (orgMeta.stateWords, orgAreas AREA_STATUSES, orgZoom stops).
 */

export type Level = "far" | "mid" | "close";
/** The app's zoom stops (orgZoom.ZOOM_STOPS): under 0.8 far, from 1.15 close. */
export const levelOf = (z: number): Level => (z < 0.8 ? "far" : z < 1.15 ? "mid" : "close");

export type CountKey = "needs" | "working" | "dormant" | "done" | "idle";
export type Counts = Partial<Record<CountKey, number>>;
export const COUNT_ORDER: CountKey[] = ["needs", "working", "dormant", "done", "idle"];
export const COUNT_META: Record<CountKey, { label: string; color: string }> = {
  needs: { label: "needs you", color: SOL.yellow },
  working: { label: "working", color: SOL.green },
  dormant: { label: "dormant", color: SOL.blue },
  done: { label: "done", color: SOL.cyan },
  idle: { label: "idle", color: SOL.base1 },
};

/** A card's sessions in words, most actionable first, at most two (orgMeta.stateWords). */
export function stateWords(c: Counts, max = 2): { text: string; color?: string }[] {
  const out: { text: string; color?: string }[] = [];
  const n = (k: CountKey) => c[k] ?? 0;
  if (n("needs")) out.push({ text: `${n("needs")} need${n("needs") === 1 ? "s" : ""} you`, color: SOL.yellow });
  if (n("working")) out.push({ text: `${n("working")} working`, color: SOL.green });
  for (const k of ["dormant", "done", "idle"] as const) if (out.length < max && n(k)) out.push({ text: `${n(k)} ${COUNT_META[k].label}` });
  return out.slice(0, max);
}

export const tallyTitle = (c: Counts) => COUNT_ORDER.filter((k) => (c[k] ?? 0) > 0).map((k) => `${c[k]} ${COUNT_META[k].label}`).join(" · ") || "no sessions";

export type Standing = "working" | "blocked" | "done" | "dormant";
export const STANDING: Record<Standing, { label: string; color: string }> = {
  working: { label: "working", color: SOL.green },
  blocked: { label: "waiting on you", color: SOL.yellow },
  done: { label: "done", color: SOL.cyan },
  dormant: { label: "dormant", color: SOL.blue },
};

export type Area = "waiting" | "stuck" | "overloaded" | "quiet" | "ok";
export const AREA: Record<Area, { label: string; color: string }> = {
  waiting: { label: "Waiting on you", color: SOL.yellow },
  stuck: { label: "Stuck", color: SOL.orange },
  overloaded: { label: "Overloaded", color: SOL.red },
  quiet: { label: "Quiet", color: SOL.base1 },
  ok: { label: "On track", color: SOL.green },
};

export type Metric = { name: string; value: string; trend: "up" | "down" | "flat"; good: boolean; date: string };

export type Holder = {
  counts: Counts;
  standing?: { s: Standing; line: string };
  area?: { status: Area; why?: string };
  /** A health flag beside the area status (orgCapacity: work in its area that never reaches it). */
  flag?: { label: string; why: string };
  charter?: string;
  work?: { tasks: number; inFlight: number; plans: number };
  running?: { id: string; title: string }[];
  metrics?: Metric[];
  /** This week: work that reached it and work it closed, Monday to Sunday. */
  week?: { reached: number[]; closed: number[] };
  /** Waits on Maya: lit by Needs you. */
  needsMaya?: boolean;
};

export const HOLDERS: Record<string, Holder> = {
  maya: { counts: { needs: 2, working: 2, dormant: 3, done: 5 } },
  leo: { counts: { working: 1, done: 2 } },
  ines: { counts: { working: 1, dormant: 1 } },
  eng: {
    counts: { working: 3, dormant: 1, done: 4 },
    standing: { s: "blocked", line: "Ship the checkout fix now? Release Captain says yes" },
    area: { status: "waiting", why: "the checkout fix" },
    charter: "Owns the codebase: sync, the apps and every release.",
    work: { tasks: 23, inFlight: 5, plans: 3 },
    running: [{ id: "ct-412", title: "Fix the sync retry storm" }, { id: "ct-419", title: "Split the daemon log by session" }],
    metrics: [{ name: "Weekly releases", value: "3 of 4", trend: "up", good: true, date: "Nov 7" }],
    week: { reached: [9, 12, 8, 14, 11, 4, 2], closed: [8, 10, 9, 12, 12, 3, 2] },
    needsMaya: true,
  },
  growth: {
    counts: { working: 1, dormant: 2, done: 3 },
    standing: { s: "blocked", line: "Post the launch thread today or Monday?" },
    area: { status: "waiting", why: "the launch thread" },
    charter: "Grows signups through the site, ads and social, inside the monthly budget.",
    work: { tasks: 11, inFlight: 2, plans: 2 },
    running: [{ id: "ct-388", title: "Rewrite the pricing page" }],
    metrics: [{ name: "Organic signups", value: "1,240 a week", trend: "up", good: true, date: "Nov 7" }],
    week: { reached: [5, 7, 6, 9, 6, 2, 1], closed: [4, 7, 5, 8, 6, 2, 1] },
    needsMaya: true,
  },
  people: {
    counts: { working: 1, done: 6 },
    standing: { s: "working", line: "Weekly company review: 4 changes drafted" },
    area: { status: "ok" },
    charter: "Keeps the org true: proposes hires, moves and record fixes for a person to approve.",
    work: { tasks: 4, inFlight: 1, plans: 0 },
    running: [{ id: "ct-431", title: "Company review, week 45" }],
    week: { reached: [3, 2, 4, 2, 3, 1, 0], closed: [3, 2, 4, 2, 2, 1, 0] },
  },
  infra: {
    counts: { working: 1, dormant: 2 },
    standing: { s: "dormant", line: "Next check 06:00; spend down 12% this week" },
    area: { status: "ok" },
    charter: "Keeps servers up and the monthly bill under $4,000.",
    work: { tasks: 6, inFlight: 1, plans: 1 },
    running: [{ id: "ct-402", title: "Move logs to cold storage" }],
    metrics: [{ name: "Monthly bill", value: "$3,420", trend: "down", good: true, date: "Nov 6" }],
    week: { reached: [4, 3, 3, 5, 2, 1, 1], closed: [4, 3, 2, 5, 3, 1, 1] },
  },
  release: {
    counts: { working: 1, done: 2 },
    standing: { s: "working", line: "Checkout fix ready on a branch" },
    area: { status: "ok" },
    charter: "Decides what ships and when, and walks the merge train.",
    work: { tasks: 5, inFlight: 2, plans: 1 },
    running: [{ id: "ct-421", title: "Release notes for 1.4.2" }],
    metrics: [{ name: "Days since a rollback", value: "19", trend: "up", good: true, date: "Nov 8" }],
    week: { reached: [2, 3, 2, 4, 3, 1, 0], closed: [2, 3, 2, 3, 4, 1, 0] },
  },
  mobile: {
    counts: { needs: 1, working: 1, dormant: 1 },
    standing: { s: "dormant", line: "TestFlight build 212 waits on a session question" },
    area: { status: "stuck", why: "1 session waiting unanswered for a day" },
    charter: "Owns the iOS and Android apps from build to store review.",
    work: { tasks: 9, inFlight: 2, plans: 1 },
    running: [{ id: "ct-397", title: "Renew the push certificate" }],
    metrics: [{ name: "Crash-free sessions", value: "99.1%", trend: "down", good: false, date: "Nov 7" }],
    week: { reached: [3, 4, 2, 3, 2, 0, 0], closed: [2, 2, 1, 1, 0, 0, 0] },
  },
  evals: {
    counts: { dormant: 1, idle: 2 },
    standing: { s: "dormant", line: "Last run Oct 23: no regressions" },
    area: { status: "quiet", why: "nothing moved for 16 days" },
    charter: "Keeps prompt and model quality from sliding between releases.",
    work: { tasks: 2, inFlight: 0, plans: 0 },
    metrics: [{ name: "Graded cases passing", value: "94%", trend: "flat", good: true, date: "Oct 23" }],
    week: { reached: [0, 0, 0, 0, 0, 0, 0], closed: [0, 0, 0, 0, 0, 0, 0] },
  },
  social: {
    counts: { done: 1 },
    standing: { s: "done", line: "Posted the 1.4.1 notes to 3 channels" },
    area: { status: "ok" },
    flag: { label: "Bypassed", why: "34 tasks closed, none reached it" },
    charter: "Turns what shipped into posts on three channels.",
    work: { tasks: 7, inFlight: 0, plans: 1 },
    metrics: [{ name: "Clicks from posts", value: "860 a week", trend: "up", good: true, date: "Nov 7" }],
    week: { reached: [1, 0, 0, 1, 0, 0, 0], closed: [1, 0, 0, 1, 0, 0, 0] },
  },
  ads: {
    counts: { working: 4, dormant: 3 },
    standing: { s: "working", line: "Pausing 14 keywords over $9 a signup" },
    area: { status: "overloaded", why: "236 items this week, 150 by task, 86 filed" },
    charter: "Runs search ads inside $1,200 a month.",
    work: { tasks: 18, inFlight: 4, plans: 2 },
    running: [{ id: "ct-409", title: "Pause keywords over $9 a signup" }, { id: "ct-414", title: "New ad group for teams" }],
    metrics: [{ name: "Cost per signup", value: "$7.80", trend: "down", good: true, date: "Nov 7" }],
    week: { reached: [31, 38, 35, 42, 36, 30, 24], closed: [22, 25, 21, 26, 23, 14, 9] },
  },
  support: {
    counts: { working: 2, done: 3 },
    standing: { s: "working", line: "Answered 11 of 12 overnight emails" },
    area: { status: "ok" },
    charter: "Answers customer mail within a day and sends bugs to engineering.",
    work: { tasks: 8, inFlight: 2, plans: 1 },
    running: [{ id: "ct-426", title: "Reply to the billing thread" }],
    metrics: [{ name: "Median first reply", value: "9 h", trend: "down", good: true, date: "Nov 8" }],
    week: { reached: [6, 5, 7, 6, 5, 3, 2], closed: [6, 5, 6, 7, 5, 3, 2] },
  },
};

/** A goal or project, owned by a person ("p:") or a role. */
export type Item = {
  id: string; kind: "mission" | "goal" | "project"; title: string; owner: string;
  goal?: string; health?: "on track" | "at risk"; counts?: Counts; metrics?: Metric[];
};

export const ITEMS: Item[] = [
  { id: "m", kind: "mission", title: "1,000 paying teams by June", owner: "p:maya", health: "on track", metrics: [{ name: "Paying teams", value: "412", trend: "up", good: true, date: "Nov 8" }] },
  { id: "g1", kind: "goal", title: "Ship weekly without breaking anything", owner: "eng", health: "on track", metrics: [{ name: "Weekly releases", value: "3 of 4", trend: "up", good: true, date: "Nov 7" }] },
  { id: "g2", kind: "goal", title: "Double organic signups by December", owner: "growth", health: "at risk", metrics: [{ name: "Signups", value: "1,240 of 2,400", trend: "up", good: true, date: "Nov 7" }] },
  { id: "g3", kind: "goal", title: "Answer every customer within a day", owner: "p:ines", health: "on track", metrics: [{ name: "Median first reply", value: "9 h", trend: "down", good: true, date: "Nov 8" }] },
  { id: "p1", kind: "project", title: "Sync engine", owner: "eng", goal: "g1", counts: { working: 2, done: 3 }, metrics: [{ name: "p95 sync lag", value: "340 ms", trend: "down", good: true, date: "Nov 7" }] },
  { id: "p2", kind: "project", title: "Release train", owner: "release", goal: "g1", counts: { working: 1, done: 2 } },
  { id: "p3", kind: "project", title: "Mobile apps", owner: "mobile", goal: "g1", counts: { needs: 1, working: 1 }, metrics: [{ name: "Crash-free", value: "99.1%", trend: "down", good: false, date: "Nov 7" }] },
  { id: "p4", kind: "project", title: "Website", owner: "growth", goal: "g2", counts: { working: 1, dormant: 1 } },
  { id: "p5", kind: "project", title: "Search ads", owner: "ads", goal: "g2", counts: { working: 4, dormant: 3 }, metrics: [{ name: "Cost per signup", value: "$7.80", trend: "down", good: true, date: "Nov 7" }] },
  { id: "p6", kind: "project", title: "Social", owner: "social", goal: "g2", counts: { done: 1 } },
  { id: "p7", kind: "project", title: "Support inbox", owner: "support", goal: "g3", counts: { working: 2, done: 3 } },
  { id: "p8", kind: "project", title: "Cost cutting", owner: "infra", counts: { working: 1, dormant: 2 } },
  { id: "p9", kind: "project", title: "Eval suite", owner: "evals", counts: { dormant: 1 } },
];

export const itemsOf = (owner: string) => ITEMS.filter((i) => i.owner === owner);
export const projectsOf = (goal: string) => ITEMS.filter((i) => i.goal === goal);
export const ownerWaits = (owner: string) => !owner.startsWith("p:") && !!HOLDERS[owner]?.needsMaya;

export const TOTALS: Counts = Object.values(HOLDERS).reduce<Counts>((acc, h) => {
  for (const k of COUNT_ORDER) acc[k] = (acc[k] ?? 0) + (h.counts[k] ?? 0);
  return acc;
}, {});

