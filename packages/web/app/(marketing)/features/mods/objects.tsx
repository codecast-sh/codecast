"use client";

import type { ComponentType, CSSProperties, ReactNode } from "react";
import {
  ArrowUpRight, Check, ChevronDown, CircleDot, Film, Flag, FileText, Flame, Folder, GitCommitHorizontal, GitPullRequest,
  Hexagon, MessageSquare, Network, Phone, Radio, Signpost, Target, UserRound, Zap, Building2, CircleDashed,
} from "lucide-react";
import { SOL } from "../../blog/blogChrome";
import { DIM, LINE, MUTED, TEXT, V, tint } from "./kit";

/*
 * The objects the page shows, drawn the way the app draws them: the pill
 * (EntityIdPill, ModObjectPill), its hover card, and a mod kind's status
 * badge. Values are illustrative; shapes, colors and fields follow the
 * product's own components.
 */

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;

export type Fact = [string, ReactNode];

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
  /** Anything a kind's card adds: a progress bar, checks, options. */
  extra?: ReactNode;
  /** The footer's left side. */
  foot?: string;
  /** Mod objects: which mod owns the kind. */
  mod?: string;
  /** Dims the pill, as a settled object does. */
  done?: boolean;
  /** Tints the icon with the status instead of the kind's color. */
  iconTone?: string;
};

/* ── The pill ─────────────────────────────────────────────────────────────── */

/** An object written inline: a faint tint of its color, its icon, its title, and the caret that opens it in place. */
export function Pill({ o, label, raw = false, className = "", style, hot }: { o: Obj; label?: string; raw?: boolean; className?: string; style?: CSSProperties; hot?: boolean }) {
  if (raw) {
    return <code className={`font-mono text-[0.86em] px-1 rounded ${className}`} style={{ backgroundColor: "rgba(147,161,161,.18)", color: TEXT, ...style }}>{o.id}</code>;
  }
  const I = o.icon;
  return (
    <span
      className={`md-pill inline-flex items-center gap-[0.25em] px-[0.25em] rounded-[0.25em] font-medium leading-none align-baseline whitespace-nowrap ${className}`}
      style={{ color: o.color, backgroundColor: tint(o.color, hot ? 18 : 9), opacity: o.done ? 0.6 : 1, boxShadow: hot ? `0 0 0 1.5px ${tint(o.color, 55)}` : undefined, ...style }}
    >
      <I className="w-[0.95em] h-[0.95em] shrink-0 opacity-85" style={o.iconTone ? { color: o.iconTone } : undefined} />
      <span className="py-[0.12em]">{label ?? o.title}</span>
      <ChevronDown className="w-[0.8em] h-[0.8em] shrink-0 opacity-50 -ml-[0.05em]" />
    </span>
  );
}

/* ── The hover card ───────────────────────────────────────────────────────── */

/** The preview a pill opens on hover: title and state, a few facts, a snippet, and a footer naming the object. */
export function HoverCard({ o, className = "", style }: { o: Obj; className?: string; style?: CSSProperties }) {
  const I = o.icon;
  return (
    <div className={`w-[300px] max-w-full rounded-lg border text-left ${className}`} style={{ backgroundColor: "#fffdf6", borderColor: LINE, boxShadow: "0 22px 48px -20px rgba(0,43,54,.45)", ...style }}>
      <div className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <I className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: o.iconTone ?? o.color }} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium leading-snug" style={{ color: TEXT }}>{o.title}</div>
            {o.state && (
              <div className="mt-1">
                {o.mod ? <StatusBadge label={o.state.label} color={o.state.color} /> : <span className="text-[10.5px] font-medium" style={{ color: o.state.color }}>{o.state.label}</span>}
              </div>
            )}
          </div>
        </div>
        {o.facts && o.facts.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-[22px] text-[11px]">
            {o.facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt style={{ color: DIM }}>{k}</dt>
                <dd className="min-w-0 truncate" style={{ color: MUTED }}>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {o.body && <p className="pl-[22px] text-[11px] leading-relaxed line-clamp-3" style={{ color: MUTED }}>{o.body}</p>}
        {o.extra && <div className="pl-[22px]">{o.extra}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: LINE, color: DIM }}>
        <span className="truncate font-mono">{o.foot ?? (o.mod ? `${o.id} · ${o.kind} · ${o.mod}` : o.id)}</span>
        <span className="inline-flex items-center gap-0.5 shrink-0">Open <ArrowUpRight className="w-2.5 h-2.5" /></span>
      </div>
    </div>
  );
}

/** A mod kind's status, as the app draws it: a dot and the word, on a tint of the status's tone. */
export function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10.5px] font-medium whitespace-nowrap" style={{ color, backgroundColor: tint(color, 14) }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "rgba(147,161,161,.2)" }}>
      <div className="h-full rounded-full" style={{ width: `${value * 100}%`, backgroundColor: color }} />
    </div>
  );
}

/* ── Built-in kinds ───────────────────────────────────────────────────────── */

export const SESSION: Obj = {
  id: "jx7c6zk", kind: "Session", icon: MessageSquare, color: SOL.blue,
  title: "Retry webhook deliveries", state: { label: "working", color: SOL.green },
  facts: [["agent", "claude · opus"], ["project", "api"], ["changes", <span key="d"><span style={{ color: SOL.green }}>+142</span> <span style={{ color: SOL.red }}>−38</span> in 6 files</span>]],
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
  extra: (
    <div className="space-y-1.5">
      <Bar value={4 / 7} color={SOL.cyan} />
      {[["Backoff with jitter", true], ["Dead letter queue", true], ["Replay from the dashboard", false]].map(([t, d]) => (
        <div key={t as string} className="flex items-center gap-1.5 text-[11px]" style={{ color: d ? DIM : MUTED }}>
          {d ? <Check className="w-3 h-3" style={{ color: SOL.green }} /> : <CircleDashed className="w-3 h-3" />}
          <span className={d ? "line-through" : ""}>{t as string}</span>
        </div>
      ))}
    </div>
  ),
};

export const PR: Obj = {
  id: "#3263", kind: "Pull request", icon: GitPullRequest, color: SOL.green,
  title: "Batch webhook retries per endpoint", state: { label: "merged · 2:08pm", color: SOL.violet }, iconTone: SOL.violet,
  facts: [["author", "Sam"], ["reviews", <span key="r" style={{ color: SOL.green }}>approved</span>], ["checks", <span key="c" style={{ color: SOL.green }}>14 passing</span>], ["branch", "retry-batch → main"]],
  extra: <div className="text-[11px] font-mono"><span style={{ color: SOL.green }}>+142</span> <span style={{ color: SOL.red }}>−38</span></div>,
};

export const DECISION: Obj = {
  id: "sd-812", kind: "Decision", icon: Signpost, color: SOL.yellow,
  title: "Exponential backoff or a fixed 30s retry?", state: { label: "Answered", color: SOL.green },
  extra: (
    <div className="space-y-1">
      {[["Exponential with jitter", true], ["Fixed 30s, capped at 10", false]].map(([t, on], i) => (
        <div key={i} className="flex items-center gap-1.5 text-[11px] rounded px-1.5 py-0.5" style={{ color: on ? TEXT : DIM, backgroundColor: on ? tint(SOL.green, 10) : undefined }}>
          <span className="font-mono text-[10px]">{i + 1}</span>{t as string}{on && <Check className="w-3 h-3 ml-auto" style={{ color: SOL.green }} />}
        </div>
      ))}
    </div>
  ),
};

export const TRIGGER: Obj = {
  id: "tr-42", kind: "Trigger", icon: Zap, color: SOL.orange,
  title: "Check CI on main", state: { label: "every 4h · next at 3pm", color: SOL.orange },
  facts: [["last run", <span key="l" style={{ color: SOL.green }}>green, 12m ago</span>], ["runs", "38"]],
};

export const CALL: Obj = {
  id: "cl-42", kind: "Call", icon: Phone, color: SOL.red,
  title: "Webhook outage review", state: { label: "34 min · 4 people", color: SOL.red },
  extra: (
    <div className="space-y-1 text-[11px] leading-snug" style={{ color: MUTED }}>
      <div><b style={{ color: TEXT, fontWeight: 600 }}>Dana</b> Cap retries at five, then dead-letter.</div>
      <div><b style={{ color: TEXT, fontWeight: 600 }}>Sam</b> And page us when the queue passes a hundred.</div>
    </div>
  ),
};

export const DOC: Obj = {
  id: "doc:k57f…", kind: "Doc", icon: FileText, color: SOL.green,
  title: "Retry policy", state: { label: "edited 2h ago", color: DIM },
  body: "Deliveries retry five times over about 30 minutes, the first after 10s, with full jitter.",
};

export const COMMIT: Obj = {
  id: "a41c9e2", kind: "Commit", icon: GitCommitHorizontal, color: SOL.yellow,
  title: "Cap webhook retries at five", state: { label: "on main · 2h ago", color: DIM },
  extra: <div className="text-[11px] font-mono"><span style={{ color: SOL.green }}>+31</span> <span style={{ color: SOL.red }}>−9</span></div>,
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
  [["severity", "sev-2"], ["service", "payments-api"], ["commander", "Dana"], ["started", "2:14pm · 41m ago"]],
  "Error rate jumped from 0.1% to 6% when v413 went out. Canary on v412 is holding.");

export const INC6 = incident(6, "Search index lagging behind writes", "resolved",
  [["severity", "sev-3"], ["service", "search"]]);

const CUS_STATUSES = ["trial", "active", "churn risk", "churned"];
function customer(id: string, title: string, status: string, facts: Fact[]): Obj {
  const tone = status === "churn risk" ? SOL.orange : status === "active" ? SOL.green : statusTone(CUS_STATUSES, status);
  return { id, kind: "Customer", mod: "Billing", icon: Building2, color: V, iconTone: tone, title, state: { label: status, color: tone }, facts };
}

export const CUS_A = customer("cus-3f9a21bc", "Acme Logistics", "active", [["plan", "Scale · 40 seats"], ["MRR", "$4,800"], ["failed charges", <span key="f" style={{ color: SOL.red }}>12 since 2:14pm</span>], ["owner", "Sam"]]);
export const CUS_B = customer("cus-77d0e412", "Northwind Bakery", "churn risk", [["plan", "Team · 8 seats"], ["MRR", "$640"], ["failed charges", <span key="f" style={{ color: SOL.red }}>5 since 2:14pm</span>]]);
