import type { ComponentType, CSSProperties } from "react";
import {
  CircleDot, Film, Flag, FileText, Flame, Folder, GitCommitHorizontal, GitPullRequest,
  Hexagon, MessageSquare, Network, Phone, Radio, Signpost, Target, UserRound, Zap, Building2,
} from "lucide-react";
import { SOL } from "../../blog/blogChrome";
import { DIM, V } from "./theme";

/*
 * The objects the page shows. Values are illustrative; shapes, colors and
 * fields follow the product's own components (EntityIdPill, ModObjectPill).
 */

export type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;

/** A fact's value: plain, or toned (a passing check in green). */
export type FactValue = string | { text: string; tone: string };
export type Fact = [string, FactValue];

/** What a kind's card adds under its facts. */
export type Extra =
  | { kind: "progress"; value: number; color: string; items: [string, boolean][] }
  | { kind: "options"; items: [string, boolean][] }
  | { kind: "quotes"; items: [string, string][] }
  | { kind: "diff"; add: number; del: number };

export type Obj = {
  /** The id as an agent writes it. */
  id: string;
  /** What the kind is called. */
  kind: string;
  icon: Icon;
  color: string;
  title: string;
  /** The state line under the title, in its own color. */
  state?: { label: string; color: string };
  facts?: Fact[];
  body?: string;
  /** Anything a kind's card adds: a progress bar, options, quotes, a diff stat. */
  extra?: Extra;
  /** The footer's left side. */
  foot?: string;
  /** Mod objects: which mod owns the kind. */
  mod?: string;
  /** Dims the pill, as a settled object does. */
  done?: boolean;
  /** Tints the icon with the status instead of the kind's color. */
  iconTone?: string;
};

/* ── Built-in kinds ───────────────────────────────────────────────────────── */

export const SESSION: Obj = {
  id: "jx7c6zk", kind: "Session", icon: MessageSquare, color: SOL.blue,
  title: "Retry webhook deliveries", state: { label: "working", color: SOL.green },
  facts: [["agent", "claude · opus"], ["project", "api"], ["files", "6 changed"]],
  extra: { kind: "diff", add: 142, del: 38 },
  body: "Swapped the fixed 30s retry for exponential backoff with jitter; replaying the outage fixture now.",
};

export const TASK: Obj = {
  id: "ct-4102", kind: "Task", icon: CircleDot, color: SOL.violet, iconTone: SOL.yellow,
  title: "Revert the retry storm in the webhook worker", state: { label: "In progress · high", color: SOL.yellow },
  facts: [["assignee", "Dana"], ["plan", "Webhook reliability"], ["sessions", "2 · 4 comments"]],
  body: "Retries fire every 30s with no cap; a 10 minute provider outage sends 20 per event.",
};

export const PLAN: Obj = {
  id: "pl-88", kind: "Plan", icon: Target, color: SOL.cyan,
  title: "Webhook reliability", state: { label: "active · 4 of 7 done", color: SOL.cyan },
  body: "Every delivery lands within 30 minutes of an outage ending, without tripping provider limits.",
  extra: { kind: "progress", value: 4 / 7, color: SOL.cyan, items: [["Backoff with jitter", true], ["Dead letter queue", true], ["Replay from the dashboard", false]] },
};

export const PR: Obj = {
  id: "#3263", kind: "Pull request", icon: GitPullRequest, color: SOL.green,
  title: "Batch webhook retries per endpoint", state: { label: "merged · 2:08pm", color: SOL.violet }, iconTone: SOL.violet,
  facts: [["author", "Sam"], ["reviews", { text: "approved", tone: SOL.green }], ["checks", { text: "14 passing", tone: SOL.green }], ["branch", "retry-batch → main"]],
  extra: { kind: "diff", add: 142, del: 38 },
};

export const DECISION: Obj = {
  id: "sd-812", kind: "Decision", icon: Signpost, color: SOL.yellow,
  title: "Exponential backoff or a fixed 30s retry?", state: { label: "Answered", color: SOL.green },
  extra: { kind: "options", items: [["Exponential with jitter", true], ["Fixed 30s, capped at 10", false]] },
};

export const TRIGGER: Obj = {
  id: "tr-42", kind: "Trigger", icon: Zap, color: SOL.orange,
  title: "Check CI on main", state: { label: "every 4h · next at 3pm", color: SOL.orange },
  facts: [["last run", { text: "green, 12m ago", tone: SOL.green }], ["runs", "38"]],
};

export const CALL: Obj = {
  id: "cl-42", kind: "Call", icon: Phone, color: SOL.red,
  title: "Webhook outage review", state: { label: "34 min · 4 people", color: SOL.red },
  extra: { kind: "quotes", items: [["Dana", "Cap retries at five, then dead-letter."], ["Sam", "And page us when the queue passes a hundred."]] },
};

export const DOC: Obj = {
  id: "doc:k57f…", kind: "Doc", icon: FileText, color: SOL.green,
  title: "Retry policy", state: { label: "edited 2h ago", color: DIM },
  body: "Deliveries retry five times over about 30 minutes, the first after 10s, with full jitter.",
};

export const COMMIT: Obj = {
  id: "a41c9e2", kind: "Commit", icon: GitCommitHorizontal, color: SOL.yellow,
  title: "Cap webhook retries at five", state: { label: "on main · 2h ago", color: DIM },
  extra: { kind: "diff", add: 31, del: 9 },
};

export const REPLAY: Obj = {
  id: "rp-19", kind: "Replay", icon: Film, color: SOL.magenta,
  title: "Checkout froze after applying a coupon", state: { label: "1 error · 2m 14s", color: SOL.magenta },
  facts: [["page", "/checkout"], ["browser", "Safari 19"]],
};

export const SOURCE: Obj = {
  id: "src-3", kind: "Source", icon: Radio, color: SOL.orange,
  title: "Sentry · web", state: { label: "healthy · 3 open groups", color: SOL.green },
};

export const INITIATIVE: Obj = {
  id: "in-5", kind: "Initiative", icon: Flag, color: SOL.magenta,
  title: "Q4 reliability", state: { label: "on track · 3 plans", color: SOL.green },
};

export const PROJECT: Obj = {
  id: "pj-api", kind: "Project", icon: Folder, color: SOL.base01,
  title: "api", state: { label: "12 open tasks", color: DIM },
};

export const ROLE: Obj = {
  id: "or-2", kind: "Role", icon: Hexagon, color: SOL.violet,
  title: "@platform-lead", state: { label: "looks after Platform", color: DIM },
};

export const PERSON: Obj = {
  id: "@dana", kind: "Person", icon: UserRound, color: SOL.green,
  title: "Dana", state: { label: "3 sessions working", color: DIM },
};

export const PROPOSAL: Obj = {
  id: "op-7", kind: "Proposal", icon: Network, color: SOL.violet,
  title: "Hire a release manager role", state: { label: "awaiting approval", color: SOL.yellow },
};

/** Every kind codecast draws without a mod, in the order the page lists them. */
export const BUILT_IN: Obj[] = [SESSION, TASK, PLAN, PR, DECISION, TRIGGER, CALL, DOC, COMMIT, REPLAY, SOURCE, INITIATIVE, PROJECT, ROLE, PERSON, PROPOSAL];

/* ── Mod kinds ────────────────────────────────────────────────────────────── */

/** Status tones as the app assigns them: the last status green, the others cycle. */
const TONES = [SOL.blue, SOL.yellow, SOL.violet, SOL.orange, SOL.cyan, SOL.magenta];
export function statusTone(statuses: string[], status: string): string {
  const i = statuses.indexOf(status);
  return i === statuses.length - 1 ? SOL.green : TONES[Math.max(i, 0) % TONES.length];
}

export const INC_STATUSES = ["triage", "mitigating", "monitoring", "resolved"];

export function incident(n: number, title: string, status: string, facts: Fact[], body?: string): Obj {
  const tone = statusTone(INC_STATUSES, status);
  return {
    id: `inc-${n}`, kind: "Incident", mod: "Incident desk", icon: Flame, color: V, iconTone: tone,
    title, state: { label: status, color: tone }, facts, body, done: status === "resolved",
  };
}

export const INC7 = incident(7, "Checkout 502s after the 2:10 deploy", "mitigating",
  [["severity", "sev-2"], ["service", "payments-api"], ["commander", "Dana"], ["started", "Oct 16, 2:14pm"]],
  "Error rate jumped from 0.1% to 6% when v413 went out. Canary on v412 is holding.");

export const INC6 = incident(6, "Search index lagging behind writes", "resolved",
  [["severity", "sev-3"], ["service", "search"]]);

const CUS_STATUSES = ["trial", "active", "churn risk", "churned"];
function customer(id: string, title: string, status: string, facts: Fact[]): Obj {
  const tone = status === "churn risk" ? SOL.orange : status === "active" ? SOL.green : statusTone(CUS_STATUSES, status);
  return { id, kind: "Customer", mod: "Billing", icon: Building2, color: V, iconTone: tone, title, state: { label: status, color: tone }, facts };
}

export const CUS_A = customer("cus-3f9a21bc", "Acme Logistics", "active", [["plan", "Scale · 40 seats"], ["MRR", "$4,800"], ["failed charges", { text: "12 since 2:14pm", tone: SOL.red }], ["owner", "Sam"]]);
export const CUS_B = customer("cus-77d0e412", "Northwind Bakery", "churn risk", [["plan", "Team · 8 seats"], ["MRR", "$640"], ["failed charges", { text: "5 since 2:14pm", tone: SOL.red }]]);
