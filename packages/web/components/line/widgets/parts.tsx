"use client";
// The small pieces every line widget shares (line-workspace.md LW3): who does
// a step, an outcome in its words, a duration, and the navigation a widget
// asks for. Inside the workspace a widget opens a step or a run in place
// (the shared selection); drawn from a `line` fence elsewhere it links to the
// project's workspace. Widgets never know which: they ask useLineNav().
import { createContext, useContext, type ReactNode } from "react";
import type { LineModel, StepKind } from "../../../lib/line/lineModel";
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
export type LineFenceScope = { projectId: string; model: LineModel; nav: LineNav };
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
