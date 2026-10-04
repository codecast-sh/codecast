"use client";

// The card a conversation shows where its agent parked on a usage limit. One
// fixed shape in every feed density — a header, one line saying which window
// closed and when it opens, one line saying what will happen next — so the
// card never grows with the banner text and never hides the "what now" behind
// a density toggle. Once a recovery acts on the park (lib/limitRecovery) the
// same card follows it: which account the session moves to, the restart, the
// "continue" landing, and finally that it resumed, so the minute a restart
// takes reads as progress and never as a stuck error. The "what next" line reads the owner machine's recovery
// flags (auto-switch, resume at reset) so it states what codecast will do,
// not a generic "send a message later"; the action row offers the one manual
// recovery that helps NOW: continue this session on the freshest saved
// account (a scoped account switch — never the whole blocked fleet), tracked
// as the conversation's sessionCommands row like every daemon command.

import Link from "next/link";
import { Check, Hourglass, Loader2, RefreshCw, TimerReset, Zap } from "lucide-react";
import { exhaustionBannerCopy, isExhaustionCurrent, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { describeDecision, pendingProposal, formatAgo, standingLabel } from "@codecast/shared/contracts";
import { useLimitRecovery } from "../hooks/useLimitRecovery";
import { useInboxStore } from "../store/inboxStore";
import { DISPATCH_REFUSED, latestSessionCommand, switchPending } from "../lib/sessionCommands";
import { formatResetPhrase, limitResetAsPrinted, limitWindowLabel, parseLimitResetAt } from "../lib/limitReset";
import type { LimitRecoveryAction } from "../lib/limitRecovery";
import { continueOnAccount, limitContinueTarget } from "../lib/limitContinue";

type Profile = { name: string; email?: string; usage?: CcUsage; login_expired_at?: number; setup_token?: { stored_at: number; expires_at: number } };

export function LimitParkCard({
  message,
  timestamp,
  conversationId,
  live,
  compact = false,
}: {
  // The card's shaped banner text ("Weekly limit · resets 7am (UTC)").
  message: string;
  timestamp?: number;
  conversationId?: string;
  // False once the session moved past the banner (see useApiErrorLive).
  live: boolean;
  compact?: boolean;
}) {
  // This conversation's own switch, if one is in flight or landed: its target
  // narrates the recovery before the machine's record catches up.
  const switchRow = useInboxStore((s) => (conversationId
    ? latestSessionCommand(s.sessionCommands, (r) => r.kind === "switch" && r.conversation_id === conversationId)
    : undefined));
  const requestedTarget = switchRow && switchRow.result !== DISPATCH_REFUSED && !switchRow.error ? switchRow.profile : undefined;
  const { now, device, phase } = useLimitRecovery(conversationId, timestamp, live, requestedTarget);
  const busy = switchPending(switchRow, now);
  const resetAt = parseLimitResetAt(message, timestamp);
  const resetPassed = resetAt != null && now >= resetAt;
  const windowLabel = limitWindowLabel(message);
  const printedReset = limitResetAsPrinted(message);
  const pinnedAccount = useInboxStore((s) => (conversationId ? s.sessions[conversationId]?.cc_account : undefined));

  const profiles: Profile[] = device?.profiles ?? [];
  // The account the session ran on (its own token pin when it has one, else
  // the machine's fleet account) and the account the button continues on: one
  // rule, shared with the phone (lib/limitContinue).
  const { fleetEmail, active, best } = limitContinueTarget(device, now, live);
  const accountLabel = pinnedAccount ?? active?.name ?? fleetEmail;
  const exhausted = isExhaustionCurrent(device?.auto_switch_state?.exhausted_at, profiles, now);
  const proposal = live && device ? pendingProposal([device], now) : null;
  // The standing shown on the button matches the meters: "stale" when a rolled
  // window is unmeasured, never a confident green percent the switcher distrusts.
  const bestNote = best ? standingLabel(best.usage, now) : null;
  const canSwitch = !!best && !!device && device.online && !device.is_remote && !!conversationId;

  const switchAndContinue = () => {
    if (best && conversationId) continueOnAccount(conversationId, best);
  };
  const continueNow = () => {
    if (!conversationId) return;
    useInboxStore.getState().sendMessage(conversationId, "continue");
  };

  if (phase.phase === "recovering" || phase.phase === "resumed") {
    return (
      <LimitRecoveryCard
        windowLabel={windowLabel}
        action={phase.action}
        step={phase.phase === "recovering" ? phase.step : "done"}
        timestamp={timestamp}
        now={now}
        compact={compact}
      />
    );
  }

  const tone = live
    ? { border: "border-amber-500/40 bg-amber-500/10", fg: "text-amber-500", icon: "bg-amber-500/20 text-amber-500" }
    : { border: "border-sol-border/40 bg-sol-bg-alt/30", fg: "text-sol-text-muted", icon: "bg-sol-bg-alt text-sol-text-muted" };

  // Line 1: what closed, and when it opens — provider clock kept in the
  // tooltip so the card can be checked against the terminal.
  const when = resetAt == null
    ? null
    : resetPassed
      ? `window reset ${formatAgo(now - resetAt)}`
      : `resets ${formatResetPhrase(resetAt, now)}`;

  // Line 2: what happens next. Reads the owner machine's flags; a viewer
  // whose roster does not carry the owner gets the neutral wording.
  let next: string;
  let nextIcon = <Hourglass className="h-3 w-3 shrink-0" />;
  if (!live) {
    next = "The session continued after this.";
  } else if (resetPassed) {
    next = "The window is open again and nothing resumed the session — continue it.";
  } else if (!device) {
    next = "Parked until the window resets — send a message after that.";
  } else if (device.auto_switch && exhausted) {
    next = exhaustionBannerCopy(profiles, now);
  } else if (proposal) {
    // Ask-first with a recommendation on the table: the card states the whole
    // ask — which window closed, and where it wants to move — so approving is
    // an informed click rather than a leap.
    nextIcon = <Zap className="h-3 w-3 shrink-0 text-sol-yellow" />;
    next = describeDecision(proposal) ?? "Waiting for you to approve an account switch.";
  } else if (device.ask_first) {
    nextIcon = <Zap className="h-3 w-3 shrink-0 text-sol-text-muted" />;
    next = "This machine asks before changing accounts — nothing has been proposed yet.";
  } else if (device.auto_switch) {
    nextIcon = <Zap className="h-3 w-3 shrink-0 text-sol-cyan" />;
    next = "Auto-switch is on — moving this session to an account with room, nothing to do.";
  } else if (device.auto_continue) {
    nextIcon = <TimerReset className="h-3 w-3 shrink-0 text-sol-cyan" />;
    next = "Resumes on its own when the window resets — nothing to do.";
  } else {
    next = "Auto-resume is off on this machine — parked until you continue it.";
  }

  return (
    <div className={`rounded-lg border ${tone.border} ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${tone.icon}`}>
          <Hourglass className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${tone.fg}`}>
          {live ? "Usage limit" : "Usage limit · resolved"}
        </span>
        <span className={`text-sm ${tone.fg}`} title={printedReset ? `Provider said: resets ${printedReset}` : undefined}>
          {windowLabel}
          {accountLabel && live ? <span className="text-sol-text-muted"> on {accountLabel}</span> : null}
          {when ? <span className="text-sol-text-muted"> · {when}</span> : null}
        </span>
        {timestamp != null && (
          <span className="ml-auto text-[10px] text-sol-text-dim shrink-0 whitespace-nowrap" title={new Date(timestamp).toLocaleString()}>
            {formatAgo(now - timestamp)}
          </span>
        )}
      </div>
      <div className={`${compact ? "mt-1" : "mt-1.5"} flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-sol-text-dim`}>
        <span className="flex items-start gap-1.5 min-w-0 flex-1">
          <span className="mt-0.5">{nextIcon}</span>
          <span>
            {next}
          </span>
        </span>
        {live && (
          <span className="ml-auto flex items-center gap-2 shrink-0">
            {resetPassed && conversationId && (
              <button
                type="button"
                onClick={continueNow}
                className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-sol-bg hover:bg-amber-400"
              >
                Continue
              </button>
            )}
            {!resetPassed && canSwitch && (
              <button
                type="button"
                onClick={switchAndContinue}
                disabled={busy}
                title={
                  proposal
                    ? `Approve the switch this machine proposed: move ${device?.label ?? "the owner machine"} to ${best?.email ?? best?.name}, restart this session, and continue it there`
                    : `Switch ${device?.label ?? "the owner machine"} to ${best?.email ?? best?.name}, restart this session, and continue it there`
                }
                className="rounded border border-amber-500/40 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 disabled:opacity-60"
              >
                {busy
                  ? "Switching…"
                  : proposal
                    ? `Approve switch to ${best?.name}${bestNote ? ` (${bestNote})` : ""}`
                    : `Continue on ${best?.name}${bestNote ? ` (${bestNote})` : ""}`}
              </button>
            )}
            <Link href="/settings/claude-accounts" className="text-[11px] text-sol-cyan hover:underline">
              Accounts
            </Link>
          </span>
        )}
      </div>
    </div>
  );
}

const STEP_DOT = {
  done: "bg-sol-green",
  active: "bg-sol-cyan animate-pulse",
  todo: "bg-sol-border",
} as const;

// One step of the track. Every step after the first carries its own leading
// connector, so a wrapped track never leaves a dangling line at a row's end.
function RecoveryStep({ state, first = false, children }: { state: keyof typeof STEP_DOT; first?: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${state === "todo" ? "text-sol-text-dim" : state === "active" ? "text-sol-text" : "text-sol-text-muted"}`}>
      {!first && <span className="mr-0.5 h-px w-4 bg-sol-border/70" />}
      {state === "done"
        ? <Check className="h-3 w-3 text-sol-green" strokeWidth={3} />
        : <span className={`h-1.5 w-1.5 rounded-full ${STEP_DOT[state]}`} />}
      {children}
    </span>
  );
}

// A park a recovery is acting on, or has resolved. While it runs, three steps:
// the limit, the move to an account with room (a restart on its credential),
// and the agent picking the turn back up once the "continue" lands. Resolved,
// one quiet line saying where it went.
function LimitRecoveryCard({
  windowLabel,
  action,
  step,
  timestamp,
  now,
  compact,
}: {
  windowLabel: string;
  action: LimitRecoveryAction;
  step: "moving" | "resuming" | "done";
  timestamp?: number;
  now: number;
  compact: boolean;
}) {
  const target = action.target;
  const moved = action.kind === "switch"
    ? target ? `switched to ${target}` : "switched accounts"
    : target ? `continued on ${target}` : "continued it";
  // "Auto-switch is moving this session to X" / "Moving this session to X".
  const verb = action.kind === "switch" ? "moving this session to" : "continuing this session on";
  const headline = `${action.by === "auto" ? `Auto-switch is ${verb}` : `${verb[0].toUpperCase()}${verb.slice(1)}`}${target ? "" : " an account with room"}`;
  const ago = timestamp != null && (
    <span className="ml-auto text-[10px] text-sol-text-dim shrink-0 whitespace-nowrap" title={new Date(timestamp).toLocaleString()}>
      {formatAgo(now - timestamp)}
    </span>
  );

  if (step === "done") {
    return (
      <div className={`rounded-lg border border-sol-border/40 bg-sol-bg-alt/30 ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
        <div className="flex items-center gap-2 text-xs min-w-0">
          <span className="inline-flex shrink-0 items-center justify-center w-4 h-4 rounded-full bg-sol-green/15 text-sol-green">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
          <span className="shrink-0 font-semibold uppercase tracking-wide text-sol-text-muted">Resumed</span>
          <span className="min-w-0 truncate text-sol-text-muted">
            {windowLabel} reached · {action.by === "auto" ? "auto-switch" : "you"} {moved}
          </span>
          {ago}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border border-sol-cyan/35 bg-sol-cyan/[0.06] ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}
      data-limit-recovery={step}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex shrink-0 items-center justify-center w-4 h-4 rounded-full bg-sol-cyan/20 text-sol-cyan">
          <RefreshCw className="h-2.5 w-2.5 animate-spin [animation-duration:2.4s]" strokeWidth={2.5} />
        </span>
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-sol-cyan">Recovering</span>
        <span className="min-w-0 truncate text-sm text-sol-text">
          {headline}{target && <> <span className="font-semibold">{target}</span></>}
        </span>
        {ago}
      </div>
      <div className={`${compact ? "mt-1" : "mt-1.5"} flex items-center gap-2 flex-wrap text-xs`}>
        <RecoveryStep state="done" first>{windowLabel} reached</RecoveryStep>
        <RecoveryStep state={step === "moving" ? "active" : "done"}>
          {step === "moving"
            ? <>{target ? `Restarting on ${target}` : "Restarting the session"}<Loader2 className="ml-0.5 h-3 w-3 animate-spin text-sol-cyan" /></>
            : target ? `Running on ${target}` : "Restarted"}
        </RecoveryStep>
        <RecoveryStep state={step === "resuming" ? "active" : "todo"}>Picking up the turn</RecoveryStep>
      </div>
    </div>
  );
}
