// A permission ask (`cast decide --run`, shared/contracts/commandRun.ts) in
// the conversation, from the ask to its record. While it waits it is a card
// at the end of the transcript: the agent's question and Yes / Not now, Yes
// marked with the fingerprint it confirms with. Once answered it shrinks to
// one line in the same place, which follows the step (running, done, didn't
// go through, not allowed) and stays in the transcript as the answer's
// record. The command itself never shows; a step that failed keeps its
// output a click away.
import { useState, type ReactNode } from "react";
import { Clock, Fingerprint, Laptop, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { permissionRecord, type PermissionOutcome } from "@codecast/shared/contracts/commandRun";
import type { DecisionAnswerMessage } from "@codecast/shared/contracts";
import { HostedApprovalBody } from "./HostedApprovalCard";
import { useDecisionAnswer } from "../../hooks/useDecisionAnswer";
import { useOneAnswer } from "../../hooks/useOneAnswer";
import { useInboxStore } from "../../store/inboxStore";
import type { QueueItem } from "../../lib/decisionQueue";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { cn } from "@/lib/utils";

type Outcome = PermissionOutcome;

const OUTCOME: Record<Outcome, { label: string; tone: string; tile: string; Icon: typeof ShieldCheck }> = {
  running: { label: "Running", tone: "text-sol-text-muted", tile: "bg-sol-blue/10 text-sol-blue", Icon: Loader2 },
  done: { label: "Done", tone: "text-sol-green", tile: "bg-sol-green/10 text-sol-green", Icon: ShieldCheck },
  failed: { label: "Didn't go through", tone: "text-sol-red", tile: "bg-sol-red/10 text-sol-red", Icon: ShieldAlert },
  declined: { label: "Not now", tone: "text-sol-text-dim", tile: "bg-sol-bg-alt text-sol-text-dim", Icon: ShieldX },
};

function Tile({ className, children, size = "lg" }: { className: string; children: ReactNode; size?: "lg" | "sm" }) {
  return (
    <span aria-hidden data-cc-row-icon className={cn("flex shrink-0 items-center justify-center rounded-md", size === "lg" ? "h-8 w-8 [&_svg]:size-[17px]" : "h-6 w-6 [&_svg]:size-3.5", className)}>
      {children}
    </span>
  );
}

/** A machine whose heartbeat is older than this is shown as offline: a run sent to it waits there. */
const MACHINE_QUIET_MS = 3 * 60_000;

/**
 * Where a permission ask runs, when that is not the session's own machine
 * (`cast decide --run --on laptop` from a cloud host): the person says Yes to
 * something on their laptop, so the card and its record name it, and say when
 * it is offline and the step waits for it.
 */
export function useRunMachine(decisionId: string | undefined): { name: string; offline: boolean } | null {
  const key = useInboxStore((s) => {
    const d = decisionId ? s.sessionDecisions[decisionId] : undefined;
    const target = d?.run?.device_id;
    if (!target) return null;
    const cid = String(d.conversation_id);
    const own = (s.sessions as any)[cid]?.owner_device_id ?? (s.conversations as any)[cid]?.owner_device_id;
    if (own && own === target) return null;
    const m = ((s as any).machineRoster ?? []).find((r: any) => r.device_id === target);
    if (!m) return null;
    return `${deviceDisplayName(m)}\u0000${Date.now() - m.last_seen > MACHINE_QUIET_MS ? 1 : 0}`;
  });
  if (!key) return null;
  const [name, off] = key.split("\u0000");
  return { name, offline: off === "1" };
}

/** The open ask, at the end of the transcript. */
export function PermissionAskCard({ item }: { item: QueueItem }) {
  const { question, options, answer } = useDecisionAnswer(item);
  const { answered, refused, pick } = useOneAnswer(answer);
  const machine = useRunMachine(item.decisionId);
  return (
    <div className="w-full pt-4" data-session-decision={item.conversationId} data-permission-ask>
      <div
        className="group/approval flex gap-3 rounded-[var(--radius,8px)] border bg-sol-card px-4 py-3.5 shadow-sm"
        style={{ borderColor: "color-mix(in srgb, var(--sol-class-amber) 38%, var(--sol-border))", animation: "fadeSlideIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both" }}
      >
        <Tile className="mt-px bg-sol-amber/15 text-sol-amber"><ShieldQuestion /></Tile>
        <div className="min-w-0 flex-1 pt-[5px]">
          <HostedApprovalBody
            question={question}
            options={options}
            onPick={pick}
            answered={answered}
            refused={refused}
            keys
            yesIcon={<Fingerprint />}
            detail={machine && (
              <p data-permission-machine className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-sol-text-dim">
                <Laptop className="size-3.5" aria-hidden />
                <span>Runs on <span className="text-sol-text-muted">{machine.name}</span></span>
                {machine.offline && <span className="text-sol-amber">· offline, runs when it is back</span>}
              </p>
            )}
          />
        </div>
      </div>
    </div>
  );
}

/** The answered ask, one line: what was asked and where the step stands. */
export function PermissionRecordLine({ question, outcome, output, machine, queued, className }: { question: string; outcome: Outcome; output?: string; machine?: { name: string; offline: boolean } | null; queued?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const o = OUTCOME[outcome];
  const waitingOn = outcome === "running" && queued && machine?.offline;
  const label = waitingOn ? `Waiting for ${machine!.name} to come online` : machine && outcome !== "declined" ? `${o.label} on ${machine.name}` : o.label;
  const why = outcome === "failed" && !!output?.trim();
  return (
    <div className={cn("w-full", className)} data-permission-record={outcome} data-cc-row="permission" data-cc-row-tone={outcome === "failed" ? "error" : undefined}>
      <div className="flex max-w-[44rem] items-center gap-2.5 py-1" style={{ animation: "fadeIn 0.2s ease-out both" }} data-cc-row-head>
        {waitingOn
          ? <Tile size="sm" className="bg-sol-amber/10 text-sol-amber"><Clock /></Tile>
          : <Tile size="sm" className={o.tile}><o.Icon className={outcome === "running" ? "animate-spin" : undefined} /></Tile>}
        <span data-cc-row-text className={cn("min-w-0 truncate text-[13px]", outcome === "declined" ? "text-sol-text-dim" : "text-sol-text-muted")} title={question}>{question}</span>
        {why ? (
          <button data-cc-row-meta type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={cn("shrink-0 text-[12px] underline-offset-2 hover:underline", o.tone)}>
            {label}
          </button>
        ) : (
          <span data-cc-row-meta role="status" className={cn("shrink-0 text-[12px]", waitingOn ? "text-sol-amber" : o.tone)}>{outcome === "running" && !waitingOn ? `${label}…` : label}</span>
        )}
      </div>
      {why && open && (
        <pre data-cc-row-detail className="m-0 ml-[34px] mt-1 max-w-[42rem] max-h-56 overflow-auto rounded-[var(--radius,8px)] border border-sol-border/70 bg-sol-bg-alt px-3 py-2 font-mono text-meta leading-relaxed text-sol-text-muted whitespace-pre-wrap break-words">{output!.trim()}</pre>
      )}
    </div>
  );
}

/** A Yes still running, holding the card's place at the end of the transcript. */
export function RunningPermissionLine({ id, question }: { id: string; question: string }) {
  const machine = useRunMachine(id);
  const queued = useRunQueued(id);
  return <PermissionRecordLine question={question} outcome="running" machine={machine} queued={queued} className="pt-4" />;
}

/** The record an answer leaves in the transcript (permissionRecord); null
 *  when the answer is not a permission ask's. */
function usePermissionRecord(decision: DecisionAnswerMessage): ReturnType<typeof permissionRecord> {
  const run = useInboxStore((s) => (decision.id ? s.sessionDecisions[decision.id]?.run : undefined));
  return permissionRecord(decision, run);
}

function useRunQueued(decisionId: string | undefined): boolean {
  return useInboxStore((s) => (decisionId ? s.sessionDecisions[decisionId]?.run?.state === "queued" : false));
}

/** An answer in the transcript: a permission ask's record line, else the
 *  ordinary answer it was going to be. */
export function PermissionAnswer({ decision, children }: { decision: DecisionAnswerMessage; children: ReactNode }) {
  const record = usePermissionRecord(decision);
  const machine = useRunMachine(decision.id);
  const queued = useRunQueued(decision.id);
  return record ? <PermissionRecordLine {...record} machine={machine} queued={queued} className="py-1.5" /> : <>{children}</>;
}
