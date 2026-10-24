import { useCallback } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { CheckCircle2, CircleSlash, ExternalLink, Loader2, Send, ShieldCheck, XCircle } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { cleanTitle } from "../../lib/conversationProcessor";
import { accentSoft, accentVar } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import { checkLabel } from "@codecast/shared/contracts";
import type { PRDetailsRead } from "../../hooks/usePRDetails";
import { PRDetailsFrame } from "./PRDetailsFrame";
import {
  CHECK_OUTCOME_ACCENT,
  checkOutcome,
  compareChecks,
  foldChecks,
  formatFailingChecksPrompt,
  type CheckOutcome,
  type PrCheck,
} from "../../lib/prView";

// The Checks tab. Failures first, because that is the only reason anyone opens
// it. Each row is one check run or commit status on the head commit. A failing
// check goes to an agent from here, one or all at once: straight to the
// shepherd when one is bound, else to a session picked in the palette.

const OUTCOME_ICON: Record<CheckOutcome, typeof CheckCircle2> = {
  passed: CheckCircle2,
  failed: XCircle,
  pending: Loader2,
  skipped: CircleSlash,
};

type ChecksPr = { repository: string; number: number; head_ref?: string; head_sha?: string; shepherd_conversation_id?: string };
type SendChecks = (checks: PrCheck[]) => void;

export function PRChecks({
  checks,
  read,
  pr,
  sessionChoices = [],
}: {
  checks: PrCheck[] | undefined;
  read?: PRDetailsRead;
  /** With it, failing checks can be sent to an agent. */
  pr?: ChecksPr;
  /** Sessions linked to the pull request, offered first when no shepherd is bound. */
  sessionChoices?: { id: string; title: string }[];
}) {
  const send = useSendChecks(pr, sessionChoices);
  return (
    <PRDetailsFrame read={read} hasRows={!!checks?.length} label="Checks">
      <CheckRows checks={checks} send={pr ? send : undefined} />
    </PRDetailsFrame>
  );
}

/** Hand failing checks to an agent as one message that says how to read their logs. */
function useSendChecks(pr: ChecksPr | undefined, sessionChoices: { id: string; title: string }[]): SendChecks {
  const sendMessage = useInboxStore((s) => s.sendMessage);
  return useCallback((checks: PrCheck[]) => {
    if (!pr || checks.length === 0) return;
    const content = formatFailingChecksPrompt(pr, checks);
    const deliver = (id: string, title: string | undefined, note?: string) => {
      sendMessage(id, note ? `${content}\n\n${note}` : content, undefined, nanoid(10));
      toast.success(`Sent to ${cleanTitle(title || "the session")}`);
    };
    const shepherd = pr.shepherd_conversation_id;
    if (shepherd) {
      deliver(shepherd, useInboxStore.getState().sessions[shepherd]?.title ?? "the shepherd");
      return;
    }
    useInboxStore.getState().openPalette({
      pick: {
        title: checks.length === 1 ? `Send ${checkLabel(checks[0])} to…` : `Send ${checks.length} failing checks to…`,
        kinds: ["session"],
        extras: sessionChoices.map((s, i) => ({ key: s.id, label: s.title, description: "Worked on this pull request", icon: "sparkles" as const, primary: i === 0 })),
        notePlaceholder: "Add a note (optional)",
        onPick: (target, result) => {
          if (target.kind === "extra") deliver(target.key, sessionChoices.find((s) => s.id === target.key)?.title, result.note);
          else deliver(target.id, target.label, result.note);
        },
      },
    });
  }, [pr, sessionChoices, sendMessage]);
}

function SendButton({ onClick, label, title }: { onClick: () => void; label: string; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sol-red/30 px-2 py-1 text-[11px] text-sol-red hover:bg-sol-red/10 transition-colors"
    >
      <Send className="w-3 h-3" />
      {label}
    </button>
  );
}

function CheckRows({ checks, send }: { checks: PrCheck[] | undefined; send?: SendChecks }) {
  const rows = [...(checks ?? [])].sort(compareChecks);
  const fold = foldChecks(checks);
  const failing = rows.filter((check) => checkOutcome(check) === "failed");

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-8 py-16 text-center">
        <ShieldCheck className="w-8 h-8 text-sol-text-dim/40" />
        <p className="text-[13px] text-sol-text-muted">{checks ? "No checks on this pull request" : "Checks have not loaded yet"}</p>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-sol-text-dim">
        <span>
          {fold.failed > 0 && <span className="text-sol-red">{fold.failed} failed · </span>}
          {fold.pending > 0 && <span className="text-sol-yellow">{fold.pending} running · </span>}
          {fold.passed} passed of {fold.total}
        </span>
        {send && failing.length > 1 && (
          <span className="ml-auto">
            <SendButton onClick={() => send(failing)} label="Send all failing" title="One message to an agent with every failing check and how to read its logs" />
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {rows.map((check) => {
          const outcome = checkOutcome(check);
          const accent = CHECK_OUTCOME_ACCENT[outcome];
          const Icon = OUTCOME_ICON[outcome];
          const body = (
            <>
              <Icon
                className={`w-4 h-4 shrink-0 ${outcome === "pending" ? "animate-spin" : ""}`}
                style={{ color: accentVar(accent) }}
              />
              <span className="font-mono text-[12px] text-sol-text truncate">{checkLabel(check)}</span>
              <span className="text-[11px]" style={{ color: accentVar(accent) }}>
                {(check.conclusion || check.status || "").replace(/_/g, " ")}
              </span>
              <span className="ml-auto text-[11px] text-sol-text-dim shrink-0">
                {relTimeShort(check.updated_at)}
              </span>
              {check.url && <ExternalLink className="w-3 h-3 text-sol-text-dim shrink-0" />}
            </>
          );
          const className = "flex min-w-0 flex-1 items-center gap-2.5";
          return (
            <div
              key={check.external_id ?? `${checkLabel(check)}:${check.suite_id ?? ""}`}
              className="pr-rise flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors hover:border-sol-border"
              style={{ borderColor: accentSoft(accent, 25), background: accentSoft(accent, 5) }}
            >
              {check.url ? (
                <a href={check.url} target="_blank" rel="noopener noreferrer" className={className}>{body}</a>
              ) : (
                <div className={className}>{body}</div>
              )}
              {send && outcome === "failed" && (
                <SendButton onClick={() => send([check])} label="Send to agent" title="Send this failure to an agent with how to read its log" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
