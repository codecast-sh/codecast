// A permission ask (`cast decide --run`, shared/contracts/commandRun.ts) in
// the conversation, from the ask to its record. While it waits it is a card
// at the end of the transcript: the agent's question and Yes / Not now, Yes
// marked with the fingerprint it confirms with. Once answered it shrinks to
// one line in the same place, which follows the step (running, done, didn't
// go through, not allowed) and stays in the transcript as the answer's
// record. The terminal line sits small at the card's foot while it waits
// (RunFallbackLine); a step that failed keeps its output a click away.
import { useState, type ReactNode } from "react";
import { Fingerprint, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { permissionRecord, type PermissionOutcome } from "@codecast/shared/contracts/commandRun";
import type { DecisionAnswerMessage } from "@codecast/shared/contracts";
import { HostedApprovalBody } from "./HostedApprovalCard";
import { RunFallbackLine } from "../decisions/RunFallbackLine";
import { useDecisionAnswer } from "../../hooks/useDecisionAnswer";
import { useOneAnswer } from "../../hooks/useOneAnswer";
import { useInboxStore } from "../../store/inboxStore";
import type { QueueItem } from "../../lib/decisionQueue";
import { cn } from "@/lib/utils";

type Outcome = PermissionOutcome;

const OUTCOME: Record<Outcome, { label: string; tone: string; tile: string; Icon: typeof ShieldCheck }> = {
  running: { label: "Running", tone: "text-sol-text-muted", tile: "bg-sol-blue/10 text-sol-blue", Icon: Loader2 },
  done: { label: "Done", tone: "text-sol-green", tile: "bg-sol-green/10 text-sol-green", Icon: ShieldCheck },
  failed: { label: "Didn't go through", tone: "text-sol-red", tile: "bg-sol-red/10 text-sol-red", Icon: ShieldAlert },
  declined: { label: "Not allowed", tone: "text-sol-text-dim", tile: "bg-sol-bg-alt text-sol-text-dim", Icon: ShieldX },
};

function Tile({ className, children, size = "lg" }: { className: string; children: ReactNode; size?: "lg" | "sm" }) {
  return (
    <span aria-hidden data-cc-row-icon className={cn("flex shrink-0 items-center justify-center rounded-md", size === "lg" ? "h-8 w-8 [&_svg]:size-[17px]" : "h-6 w-6 [&_svg]:size-3.5", className)}>
      {children}
    </span>
  );
}

/** The open ask, at the end of the transcript. */
export function PermissionAskCard({ item }: { item: QueueItem }) {
  const { question, options, answer } = useDecisionAnswer(item);
  const { answered, refused, pick } = useOneAnswer(answer);
  const run = useInboxStore((s) => (item.decisionId ? s.sessionDecisions[item.decisionId]?.run : undefined));
  return (
    <div className="w-full pt-4" data-session-decision={item.conversationId} data-permission-ask>
      <div
        className="group/approval flex gap-3 rounded-[var(--radius,8px)] border bg-sol-card px-4 py-3.5 shadow-sm"
        style={{ borderColor: "color-mix(in srgb, var(--sol-class-amber) 38%, var(--sol-border))", animation: "fadeSlideIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both" }}
      >
        <Tile className="mt-px bg-sol-amber/15 text-sol-amber"><ShieldQuestion /></Tile>
        <div className="min-w-0 flex-1 pt-[5px]">
          <HostedApprovalBody question={question} options={options} onPick={pick} answered={answered} refused={refused} keys yesIcon={<Fingerprint />} />
          <RunFallbackLine run={run} className="mt-3" />
        </div>
      </div>
    </div>
  );
}

/** The answered ask, one line: what was asked and where the step stands. */
export function PermissionRecordLine({ question, outcome, output, className }: { question: string; outcome: Outcome; output?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const o = OUTCOME[outcome];
  const why = outcome === "failed" && !!output?.trim();
  return (
    <div className={cn("w-full", className)} data-permission-record={outcome} data-cc-row="permission" data-cc-row-tone={outcome === "failed" ? "error" : undefined}>
      <div className="flex max-w-[44rem] items-center gap-2.5 py-1" style={{ animation: "fadeIn 0.2s ease-out both" }} data-cc-row-head>
        <Tile size="sm" className={o.tile}><o.Icon className={outcome === "running" ? "animate-spin" : undefined} /></Tile>
        <span data-cc-row-text className={cn("min-w-0 truncate text-[13px]", outcome === "declined" ? "text-sol-text-dim" : "text-sol-text-muted")} title={question}>{question}</span>
        {why ? (
          <button data-cc-row-meta type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={cn("shrink-0 text-[12px] underline-offset-2 hover:underline", o.tone)}>
            {o.label}
          </button>
        ) : (
          <span data-cc-row-meta role="status" className={cn("shrink-0 text-[12px]", o.tone)}>{outcome === "running" ? `${o.label}…` : o.label}</span>
        )}
      </div>
      {why && open && (
        <pre data-cc-row-detail className="m-0 ml-[34px] mt-1 max-w-[42rem] max-h-56 overflow-auto rounded-[var(--radius,8px)] border border-sol-border/70 bg-sol-bg-alt px-3 py-2 font-mono text-meta leading-relaxed text-sol-text-muted whitespace-pre-wrap break-words">{output!.trim()}</pre>
      )}
    </div>
  );
}

/** The record an answer leaves in the transcript (permissionRecord); null
 *  when the answer is not a permission ask's. */
function usePermissionRecord(decision: DecisionAnswerMessage): ReturnType<typeof permissionRecord> {
  const run = useInboxStore((s) => (decision.id ? s.sessionDecisions[decision.id]?.run : undefined));
  return permissionRecord(decision, run);
}

/** An answer in the transcript: a permission ask's record line, else the
 *  ordinary answer it was going to be. */
export function PermissionAnswer({ decision, children }: { decision: DecisionAnswerMessage; children: ReactNode }) {
  const record = usePermissionRecord(decision);
  return record ? <PermissionRecordLine {...record} className="py-1.5" /> : <>{children}</>;
}
