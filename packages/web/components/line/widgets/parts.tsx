"use client";
// The small pieces every line widget shares (line-workspace.md LW3): who does
// a step, an outcome in its words, a duration, and the navigation a widget
// asks for. Inside the workspace a widget opens a step or a run in place
// (the shared selection); drawn from a `line` fence elsewhere it links to the
// project's workspace. Widgets never know which: they ask useLineNav().
import { createContext, useContext, type ReactNode } from "react";
import { decisionKey, type DecisionClose, type LineModel, type StepDecision, type StepKind } from "../../../lib/line/lineModel";
import type { StepState } from "../../../lib/line/runReport";
import { formatElapsed } from "../../../lib/taskLine";

export type LineNav = {
  /** Open a step: the workspace's drawer, else the step in the workspace. */
  openStep: (stepId: string) => void;
  /** Open a run, with its case. */
  openRun: (runId: string, caseId: string | null) => void;
  /** Where opening a step goes, for a real link (middle click, copy). */
  stepHref: (stepId: string) => string | null;
  runHref: (runId: string, caseId: string | null) => string | null;
  /** Open a case's timeline (a problem); absent where the widget only reads. */
  openCase?: (caseId: string) => void;
  caseHref?: (caseId: string) => string | null;
  /** The project whose line this is, where a widget acts on it (Try, Ask an agent); absent where it only reads. */
  projectId?: string;
};

const NO_NAV: LineNav = { openStep: () => {}, openRun: () => {}, stepHref: () => null, runHref: () => null };
const LineNavContext = createContext<LineNav>(NO_NAV);

export function LineNavProvider({ nav, children }: { nav: LineNav; children: ReactNode }) {
  return <LineNavContext.Provider value={nav}>{children}</LineNavContext.Provider>;
}
export const useLineNav = () => useContext(LineNavContext);

/** A surface that already holds a project's model (the workspace): a `line`
 *  fence for that project inside it draws from this model and opens steps
 *  and runs in place, instead of reading the line again and linking away. */
export type LineFenceScope = { projectId: string; model: LineModel; nav: LineNav; now: number };
const LineFenceScopeContext = createContext<LineFenceScope | null>(null);
export function LineFenceScopeProvider({ scope, children }: { scope: LineFenceScope | null; children: ReactNode }) {
  return <LineFenceScopeContext.Provider value={scope}>{children}</LineFenceScopeContext.Provider>;
}
export const useLineFenceScope = () => useContext(LineFenceScopeContext);

const KIND_WORDS: Record<StepKind, string> = { agent: "Agent", person: "You decide", script: "Script", end: "End" };

/** Who does a step, as a chip: an agent's dot, a person's diamond, a script's square. */
export function KindTag({ kind, children }: { kind: StepKind; children?: ReactNode }) {
  return <span className="lw-kind" data-kind={kind}>{children ?? KIND_WORDS[kind]}</span>;
}

export type OutcomeTone = "ok" | "warn" | "bad" | "live" | "person" | "none";

const BAD = /\b(fail|failed|failure|error|reject|rejected|stopped|timed?\s?out|crash)/i;
const WARN = /\b(not[_ ]reproduced|infeasible|changes|revise|strategy[_ ]fails|wrong[_ ]cause|judge[_ ]defect|stuck|retry|escalat)/i;
const STOP = /\b(dissolved|closed|dropped|released|carried|approve|approved|shipped|merged|red|built|proposed|mechanism|refined|written)\b/i;

/** An outcome's tone from its words and the visit's state: failures red,
 *  sends-back yellow, a step that settled something green, the rest plain. */
export function outcomeTone(words: string | null | undefined, status?: StepState): OutcomeTone {
  // A session cut off decided nothing: grey, not a red mark against the step.
  if (words === CUT_OFF) return "none";
  if (status === "failed") return "bad";
  if (status === "live") return "live";
  if (status === "waiting") return "person";
  const w = words ?? "";
  if (BAD.test(w)) return "bad";
  if (WARN.test(w)) return "warn";
  if (STOP.test(w)) return "ok";
  return "none";
}

/** An outcome key as a reader says it: "not_reproduced" reads "not reproduced". */
export const outcomeWords = (outcome: string | null | undefined, status?: StepState): string =>
  outcome ? outcome.replace(/_/g, " ") : status === "live" ? "running" : status === "waiting" ? "waiting" : status === "failed" ? "failed" : "handed on";

const CUT_OFF = "cut off";

/** A close that did not hold (lineModel DecisionClose): "came back 3× after this", red, with the history's own words on hover. Nothing when it held or closed nothing. */
export function CameBackTag({ closed }: { closed: DecisionClose | null | undefined }) {
  if (!closed || closed.held) return null;
  return (
    <span className="lw-oc" data-tone="bad" data-came-back="" title={`${closed.words ?? "The problem came back"}. The close was likely wrong.`}>
      came back {closed.count === 1 ? "" : `${closed.count}× `}after this
    </span>
  );
}

/** A group of a case's runs whose closes did not hold: "4 came back", red, on the header that folds them. */
export function GroupBackTag({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="lw-oc" data-tone="bad" data-came-back="" title={`${n} of these runs closed the problem and it came back after`}>{n} came back</span>;
}

/** How many runs took a way out, and how many of those closes the problem came back after: "6×, 4 came back". The came-back part is red. */
export function RouteCount({ count, back = 0, className }: { count: number; back?: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={className} data-came-back={back > 0 ? "" : undefined}>
      {count}×{back > 0 && <span className="lw-route-back">, {back} came back</span>}
    </span>
  );
}

/** The tone of a decision that closed a problem: by whether the close held, never the green of a good end when it came back. */
export const closedTone = (closed: DecisionClose | null | undefined): OutcomeTone | null => (closed && !closed.held ? "bad" : null);

/** What a decision decided, as a tag: its key in the step's tally (decisionKey), so a tag and the counts above it say the same word.
 *  A close the problem came back after is red and says so beside it. */
export function DecisionTag({ d, title }: { d: Pick<StepDecision, "status" | "decided" | "closed">; title?: string }) {
  const key = decisionKey(d);
  // A session that reported and then failed decided what it reported: toned by its words, not its end.
  const tone = closedTone(d.closed) ?? outcomeTone(key, key === "failed" || key === CUT_OFF ? d.status : d.status === "failed" ? undefined : d.status);
  return (
    <>
      <span className="lw-oc" data-tone={tone} data-cut={key === CUT_OFF ? "" : undefined} title={title ?? (key === CUT_OFF ? "The session was cut off before it decided" : undefined)}>{outcomeWords(key)}</span>
      <CameBackTag closed={d.closed} />
    </>
  );
}

export function OutcomeTag({ outcome, status, title }: { outcome: string | null | undefined; status?: StepState; title?: string }) {
  const words = outcomeWords(outcome, status);
  return <span className="lw-oc" data-tone={outcomeTone(outcome ?? words, status)} title={title}>{words}</span>;
}

/** A duration in its largest units: "4m", "2h 5m", "40s". */
export function durationWords(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return (formatElapsed(0, ms) ?? "").replace(/ 0[hm]$/, "") || null;
}

/** A date as the line's other pages say one: "Oct 8". */
export const dayWords = (at: number | null | undefined) => (at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null);

/** A button that is a link when it can be: middle click and copy work, a plain click stays in place. */
export function NavLink({ href, onOpen, className, children, title }: { href: string | null; onOpen: () => void; className?: string; children: ReactNode; title?: string }) {
  if (!href) return <button type="button" className={className} onClick={onOpen} title={title}>{children}</button>;
  return (
    <a
      href={href}
      className={className}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen();
      }}
    >
      {children}
    </a>
  );
}
