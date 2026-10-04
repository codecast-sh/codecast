"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, ArrowUpRight, Layers } from "lucide-react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { SOL } from "../../blog/blogChrome";
import { B, Dot, Y } from "./kit";

/*
 * Faithful mocks of the real decision surfaces (components/SessionDecisionCard,
 * decisions/DecisionOptionList, decisions/StackChecklist, mobile
 * app/decisions/[id]). Same structure, same words, same keys; static props
 * instead of the store.
 */

export const LINE = "rgba(147,161,161,.38)";
export const TEXT = SOL.base02;
export const MUTED = SOL.base00;
export const DIM = SOL.base1;

export type MockOption = { label: string; description?: string };

/** One option row: the digit the key answers, the label, and what choosing it means right beneath. */
export function OptionRow({ option, n, primary = false, picked = false, tag, compact = false, className = "" }: {
  option: MockOption; n: number; primary?: boolean; picked?: boolean; tag?: ReactNode; compact?: boolean; className?: string;
}) {
  const border = picked ? "rgba(133,153,0,.55)" : primary ? "rgba(181,137,0,.5)" : LINE;
  return (
    <div
      className={`dq-option w-full flex items-start gap-3 rounded-lg border ${compact ? "px-3 py-2" : "px-4 py-3"} ${className}`}
      style={{ borderColor: border, backgroundColor: picked ? "rgba(133,153,0,.07)" : "transparent" }}
      data-option={n}
    >
      <span className="shrink-0 mt-[2px]"><KeyCap size={compact ? "xs" : "sm"}>{String(n + 1)}</KeyCap></span>
      <span className="min-w-0 flex-1 text-left [overflow-wrap:anywhere]">
        <span className="flex items-center gap-2 flex-wrap">
          <span className={`${compact ? "text-[13px]" : "text-[14.5px]"} leading-snug`} style={{ color: TEXT }}>{option.label}</span>
          {tag}
        </span>
        {option.description && (
          <span className={`block mt-0.5 leading-snug ${compact ? "text-[12px]" : "text-[13px]"}`} style={{ color: MUTED }}>{option.description}</span>
        )}
      </span>
    </div>
  );
}

/** The small bordered tag the product puts beside the agent's default. */
export function DefaultTag() {
  return <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ borderColor: LINE, color: DIM }}>proceeding with this</span>;
}

/** The "advisory" badge in the sheet's header row. */
export function AdvisoryBadge() {
  return <span className="text-[10px] px-1.5 py-0.5 rounded border shrink-0" style={{ borderColor: "rgba(38,139,210,.3)", color: B }}>advisory</span>;
}

/** The question, set in the serif the decision page uses. */
export function Question({ children, size = "md" }: { children: ReactNode; size?: "md" | "sm" }) {
  return (
    <div
      className={`${size === "md" ? "text-[22px] sm:text-[25px]" : "text-[18px]"} leading-[1.2] tracking-[-0.01em] [text-wrap:balance]`}
      style={{ fontFamily: "var(--font-serif), Georgia, serif", fontWeight: 500, color: TEXT }}
    >
      {children}
    </div>
  );
}

/** The reasoning block: body type with the left rule. */
export function Reasoning({ children }: { children: ReactNode }) {
  return <div className="text-[13px] leading-[1.6] border-l-2 pl-4 space-y-2" style={{ color: MUTED, borderColor: LINE }}>{children}</div>;
}

/** The low key line under the options: o / s / x / esc. */
export function EscapeHatch({ queue = true }: { queue?: boolean }) {
  const item = (k: string, label: string) => (
    <span className="flex items-center gap-1.5"><KeyCap size="xs">{k}</KeyCap><span>{label}</span></span>
  );
  return (
    <div className="flex items-center flex-wrap gap-x-4 gap-y-2 text-[11px] mt-4" style={{ color: DIM }}>
      {queue && item("o", "open the session")}
      {queue && item("s", "skip for now")}
      {item("x", "dismiss")}
      {queue && item("esc", "leave the queue")}
    </div>
  );
}

/** "or type an answer in your own words", the t key. */
export function TypeAnswer() {
  return (
    <div className="flex items-center gap-1.5 text-[12px] pt-1" style={{ color: DIM }}>
      <KeyCap size="xs">t</KeyCap><span>or type an answer in your own words</span>
    </div>
  );
}

/** An embedded published page, drawn as a small report preview. */
export function ReportEmbed({ slug, title, rows }: { slug: string; title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
      <div className="flex items-center gap-2 px-3 h-7 border-b text-[10.5px] font-mono" style={{ borderColor: LINE, color: DIM, backgroundColor: SOL.base2 }}>
        <span className="truncate">codecast.sh/a/{slug}</span>
        <ArrowUpRight className="w-3 h-3 ml-auto shrink-0" />
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[12px] font-semibold mb-2" style={{ color: TEXT }}>{title}</div>
        <div className="space-y-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2 text-[11px]">
              <span className="shrink-0" style={{ color: DIM }}>{k}</span>
              <span className="flex-1 border-b border-dotted translate-y-[-3px]" style={{ borderColor: LINE }} />
              <span className="font-mono shrink-0" style={{ color: TEXT }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export type SheetData = {
  session: string;
  project: string;
  tier: 1 | 2 | 3;
  asked: string;
  question: string;
  context: ReactNode;
  options: MockOption[];
  defaultOption?: number;
  report?: ReactNode;
  documentLink?: boolean;
};

/**
 * The decision sheet as the queue shows it: one row of chrome (who is asking,
 * the position, the way back to the thread), then the question, the
 * reasoning and the options in one flow.
 */
export function DecisionSheet({ d, position, total, pickedOption, pickAt, pickClass = "dq-pick", className = "", wide = false }: {
  d: SheetData; position: number; total: number; pickedOption?: number; pickAt?: number; pickClass?: string; className?: string; wide?: boolean;
}) {
  return (
    <div className={`rounded-xl border overflow-hidden flex flex-col ${className}`} style={{ backgroundColor: SOL.base3, borderColor: LINE, boxShadow: "0 24px 50px -28px rgba(0,43,54,.45), 0 2px 0 rgba(0,43,54,.04)" }}>
      <div className="shrink-0 border-b px-4 sm:px-5 h-10 flex items-center gap-2.5 min-w-0" style={{ borderColor: LINE }}>
        <Dot tier={d.tier} />
        <span className="text-[13px] truncate" style={{ color: TEXT }}>{d.session}</span>
        <span className="hidden sm:inline text-[11px] truncate" style={{ color: DIM }}>{d.project}</span>
        {d.tier === 3 && <AdvisoryBadge />}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums" style={{ color: DIM }}>
          <span className="hidden sm:inline">decision {position} of {total}</span>
          <span className="sm:hidden">{position}/{total}</span>
        </span>
        <span className="shrink-0 flex items-center gap-1 pl-1.5 pr-2 sm:pr-2.5 py-0.5 rounded-full border text-[11px]" style={{ borderColor: LINE, color: MUTED }}>
          <ChevronDown className="w-3.5 h-3.5" /><span className="hidden sm:inline">Read the thread</span>
        </span>
      </div>
      <div className="px-4 sm:px-5 pt-3.5 pb-5 flex-1">
        <div className="mb-2 flex items-center gap-3 flex-wrap text-[11px]" style={{ color: DIM }}>
          <span>{d.asked}</span>
          {d.documentLink && <span className="inline-flex items-center gap-1" style={{ color: B }}>read the full decision<ArrowUpRight className="w-3 h-3" /></span>}
        </div>
        <div className="mb-4"><Question>{d.question}</Question></div>
        <div className={wide ? "grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 items-start" : "space-y-4"}>
          <div className="space-y-3 min-w-0">
            <Reasoning>{d.context}</Reasoning>
            {d.report}
          </div>
          <div className="min-w-0">
            <div className="space-y-2">
              {d.options.map((o, n) => (
                <OptionRow
                  key={n}
                  option={o}
                  n={n}
                  primary={n === 0}
                  picked={pickedOption === n}
                  className={pickAt === n ? pickClass : ""}
                  tag={d.defaultOption === n ? <DefaultTag /> : undefined}
                />
              ))}
              <TypeAnswer />
            </div>
            <EscapeHatch />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The fold: the one small pill above the composer while an advisory ask waits. */
export function FoldPill({ blocking = false, label, position }: { blocking?: boolean; label: string; position?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 pl-2 pr-2.5 py-0.5 rounded-full border text-[11px] max-w-full"
      style={blocking ? { borderColor: "rgba(181,137,0,.5)", color: TEXT } : { borderColor: "rgba(38,139,210,.4)", color: B }}
    >
      <Dot tier={blocking ? 1 : 3} />
      <span className="truncate">{label}</span>
      <span className="opacity-70 shrink-0">· {position ?? "answer"}</span>
      <ChevronUp className="w-3.5 h-3.5 shrink-0" />
    </span>
  );
}

/** The answer as it lands in the asking session: a user message with the decision tag, linked back to the ask. */
export function AnswerBubble({ label, question, note }: { label: string; question: string; note?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-[12px] leading-5" style={{ borderColor: "rgba(133,153,0,.4)", backgroundColor: "rgba(133,153,0,.06)" }}>
      <div style={{ color: TEXT }}>Decision: <span className="font-semibold">{label}</span></div>
      <div className="truncate" style={{ color: DIM }}>{note ?? "answers"} · {question}</div>
    </div>
  );
}

/** A stack rendered as the queue's checklist. */
export function StackChecklistMock() {
  const rows: { q: string; state: "done" | "current" | "open"; answer?: string; advisory?: boolean }[] = [
    { q: "Ship the pricing banner on Monday?", state: "done", answer: "Ship" },
    { q: "Which plan is the default on signup?", state: "done", answer: "Team" },
    { q: "Send the launch email to the waitlist?", state: "current" },
    { q: "Annual toggle on or off by default?", state: "open", advisory: true },
    { q: "Keep the free tier's 3 seat cap?", state: "open", advisory: true },
  ];
  return (
    <div className="rounded-xl border p-4 sm:p-5" style={{ backgroundColor: SOL.base3, borderColor: LINE }}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <Layers className="w-4 h-4" style={{ color: SOL.violet }} />
        <span className="text-[14px] font-semibold" style={{ color: TEXT }}>Launch checklist</span>
        <span className="font-mono text-[11px]" style={{ color: DIM }}>ds-7</span>
        <span className="ml-auto text-[10.5px] px-1.5 py-0.5 rounded border" style={{ borderColor: "rgba(220,50,47,.4)", color: SOL.red }}>due 2h ago</span>
      </div>
      <div className="text-[11px] mb-4" style={{ color: DIM }}>advisory members answer with their default after 24h</div>
      <div className="flex items-center gap-3 flex-wrap text-[11px] mb-3" style={{ color: DIM }}>
        <span>2 of 5 cleared</span>
        <div className="flex-1 min-w-[5rem] h-px relative" style={{ backgroundColor: LINE }}>
          <div className="absolute inset-y-0 left-0 dq-grow" style={{ width: "40%", backgroundColor: "rgba(42,161,152,.7)" }} />
        </div>
        <span className="flex items-center gap-1"><KeyCap size="xs">p</KeyCap><ChevronLeft className="w-3 h-3" />previous</span>
        <span className="flex items-center gap-1">next<ChevronRight className="w-3 h-3" /><KeyCap size="xs">n</KeyCap></span>
      </div>
      <ol className="space-y-1.5">
        {rows.map((r, i) =>
          r.state === "current" ? (
            <li key={i} className="rounded-lg border p-3" style={{ borderColor: "rgba(181,137,0,.5)" }}>
              <div className="text-[13.5px] mb-2.5" style={{ color: TEXT }}>{r.q}</div>
              <div className="space-y-1.5">
                <OptionRow compact n={0} primary option={{ label: "Send Tuesday 9am", description: "the copy passed review on Friday" }} />
                <OptionRow compact n={1} option={{ label: "Hold a week", description: "lands after the docs refresh" }} />
              </div>
            </li>
          ) : (
            <li key={i} className="flex items-center gap-2.5 px-3 py-1.5 text-[12.5px]" style={{ color: r.state === "done" ? DIM : MUTED }}>
              <span className="w-4 text-center font-mono text-[11px]" style={{ color: r.state === "done" ? SOL.green : DIM }}>{r.state === "done" ? "✓" : i + 1}</span>
              <span className={`min-w-0 flex-1 truncate ${r.state === "done" ? "line-through" : ""}`} style={{ textDecorationColor: LINE }}>{r.q}</span>
              {r.answer && <span className="text-[11px] shrink-0">{r.answer}</span>}
              {r.advisory && <AdvisoryBadge />}
            </li>
          ),
        )}
      </ol>
      <div className="mt-4 flex items-center gap-2 flex-wrap text-[11px]">
        <span className="px-2 py-1 rounded border" style={{ borderColor: "rgba(38,139,210,.4)", color: B }}>answer all defaults (2)</span>
        <span style={{ color: DIM }}>resolves every advisory member with the default its agent declared</span>
      </div>
    </div>
  );
}

/** The phone screen: one decision at a time, the same queue order. */
export function PhoneDecision() {
  return (
    <div className="px-4 pb-6 pt-1 text-left" style={{ backgroundColor: SOL.base3 }}>
      <div className="flex items-center justify-between h-10 text-[13px]" style={{ color: TEXT }}>
        <span className="flex items-center gap-0.5" style={{ color: B }}><ChevronLeft className="w-4 h-4" />Decisions</span>
        <span className="font-semibold">2 of 5</span>
        <span className="w-16" />
      </div>
      <div className="mt-2 mb-1 text-[19px] leading-[1.25]" style={{ fontFamily: "var(--font-serif), Georgia, serif", fontWeight: 500, color: TEXT }}>
        Exponential backoff or a fixed 30s retry?
      </div>
      <div className="text-[11.5px] mb-3" style={{ color: B }}>Retry webhook deliveries · api ›</div>
      <div className="text-[12px] leading-[1.55] mb-4" style={{ color: MUTED }}>
        A 10 minute outage at the provider sends 20 retries per event today and trips their rate limit.
      </div>
      <div className="space-y-2">
        {[
          { l: "Exponential with jitter", d: "5 retries over about 30m" },
          { l: "Fixed 30s, capped at 10", d: "simplest; still bursts" },
        ].map((o, i) => (
          <div key={i} className="flex gap-2.5 rounded-xl border px-3 py-2.5" style={{ borderColor: i === 0 ? "rgba(181,137,0,.5)" : LINE }}>
            <span className="w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-[10px] font-mono" style={{ borderColor: LINE, color: DIM }}>{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[13px]" style={{ color: TEXT }}>{o.l}</span>
              <span className="block text-[11.5px]" style={{ color: MUTED }}>{o.d}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border px-3 py-2.5 text-[12px]" style={{ borderColor: LINE, color: DIM }}>Or answer in your own words</div>
      <div className="mt-4 flex items-center justify-between text-[12.5px]" style={{ color: DIM }}>
        <span>Dismiss</span><span>Skip ›</span>
      </div>
    </div>
  );
}

/** A compact queue row, for the ordering diagram. */
export function QueueRow({ tier, session, question, age, note }: { tier: 1 | 2 | 3; session: string; question: string; age: string; note?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: LINE, backgroundColor: SOL.base3 }}>
      <span className="mt-[7px]"><Dot tier={tier} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug truncate" style={{ color: TEXT }}>{question}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] flex-wrap" style={{ color: DIM }}>
          <span className="truncate">{session}</span>
          <span>·</span>
          <span>{age}</span>
          {tier === 3 && <AdvisoryBadge />}
          {tier === 2 && <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ borderColor: LINE, color: DIM }}>session not running</span>}
          {note && <span style={{ color: MUTED }}>{note}</span>}
        </div>
      </div>
    </div>
  );
}

export { Y };
