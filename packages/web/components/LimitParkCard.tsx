"use client";

// The card a conversation shows where its agent parked on a usage limit. One
// fixed shape in every feed density — a header, one line saying which window
// closed and when it opens, one line saying what will happen next — so the
// card never grows with the banner text and never hides the "what now" behind
// a density toggle. The "what next" line reads the owner machine's recovery
// flags (auto-switch, resume at reset) so it states what codecast will do,
// not a generic "send a message later"; the action row offers the one manual
// recovery that helps NOW: continue this session on the freshest saved
// account (a scoped requestAccountSwitch — never the whole blocked fleet).

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Hourglass, TimerReset, Zap } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { exhaustionBannerCopy, isExhaustionCurrent, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { formatAgo, formatCountdown, isUsageExhausted, rankByHeadroom, worstUsagePercent } from "@codecast/shared/contracts";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useInboxStore } from "../store/inboxStore";
import { formatResetLocal, limitResetAsPrinted, limitWindowLabel, parseLimitResetAt } from "../lib/limitReset";

type Profile = { name: string; email?: string; usage?: CcUsage; login_expired_at?: number };

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
  const now = useCoarseNow(30_000);
  const resetAt = parseLimitResetAt(message, timestamp);
  const resetPassed = resetAt != null && now >= resetAt;
  const windowLabel = limitWindowLabel(message);
  const printedReset = limitResetAsPrinted(message);
  const ownerDeviceId = useInboxStore((s) => (conversationId ? s.sessions[conversationId]?.owner_device_id : undefined));
  // Enrichment only: without it the card still says what closed and when it
  // opens, so a backend that cannot serve the roster costs the "what next"
  // line, never the card.
  const { data } = useQueryNoThrow(api.accountSwitch.listAccountProfiles, live ? {} : "skip");
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const [busy, setBusy] = useState(false);

  const devices = data?.devices ?? [];
  const device = devices.find((d) => d.device_id === ownerDeviceId) ?? devices.find((d) => !d.is_remote && d.online);
  const profiles: Profile[] = device?.profiles ?? [];
  const active = profiles.find((p) => p.email && p.email === device?.active_email);
  const accountLabel = active?.name ?? device?.active_email;
  const exhausted = isExhaustionCurrent(device?.auto_switch_state?.exhausted_at, profiles, now);
  // The freshest OTHER saved account with room left — the one manual recovery
  // worth a button. Expired logins and pegged accounts are not offers.
  const best = rankByHeadroom(
    profiles.filter((p) => p.email && p.email !== device?.active_email && !p.login_expired_at && !isUsageExhausted(p.usage, now)),
    now,
  )[0];
  const bestPct = best?.usage ? worstUsagePercent(best.usage, now) : null;
  const canSwitch = !!best && !!device && device.online && !device.is_remote && !!conversationId;

  // Continue THIS session on another account: paint the "continue" it is
  // about to receive, stamp it revive-in-flight, and hand the daemon the same
  // client id so the echo replaces the painted bubble (the fleet banner's
  // contract, scoped to one conversation).
  const switchAndContinue = async () => {
    if (!best?.email || !conversationId) return;
    const store = useInboxStore.getState();
    const clientId = `acct-revive-${Math.random().toString(36).slice(2, 10)}-${conversationId}`;
    store.addOptimisticMessage(conversationId, "continue", undefined, clientId);
    store.markBlockedReviveRequested([conversationId]);
    setBusy(true);
    try {
      await requestSwitch({
        email: best.email,
        conversation_ids: [conversationId as Id<"conversations">],
        include_subagents: true,
        continue_client_ids: { [conversationId]: clientId },
      });
      toast.success(`Switching to ${best.name} — this session continues on it`);
    } catch (err) {
      store.removeOptimisticMessage(conversationId, clientId);
      store.clearBlockedReviveRequested([conversationId]);
      toast.error(err instanceof Error ? err.message : "Account switch failed");
    } finally {
      setBusy(false);
    }
  };
  const continueNow = () => {
    if (!conversationId) return;
    useInboxStore.getState().sendMessage(conversationId, "continue");
  };

  const tone = live
    ? { border: "border-amber-500/40 bg-amber-500/10", fg: "text-amber-500", icon: "bg-amber-500/20 text-amber-500" }
    : { border: "border-sol-border/40 bg-sol-bg-alt/30", fg: "text-sol-text-muted", icon: "bg-sol-bg-alt text-sol-text-muted" };

  // Line 1: what closed, and when it opens — provider clock kept in the
  // tooltip so the card can be checked against the terminal.
  const when = resetAt == null
    ? null
    : resetPassed
      ? `window reset ${formatAgo(now - resetAt)}`
      : `resets in ${formatCountdown(resetAt - now)} · ${formatResetLocal(resetAt, now)}`;

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
  } else if (device.auto_switch) {
    nextIcon = <Zap className="h-3 w-3 shrink-0 text-sol-cyan" />;
    next = "Auto-switch is on — continues on the freshest saved account by itself.";
  } else if (device.auto_continue) {
    nextIcon = <TimerReset className="h-3 w-3 shrink-0 text-sol-cyan" />;
    next = "Resumes on its own when the window resets — nothing to do.";
  } else {
    next = "Auto-resume is off on this machine — parked until you continue it.";
  }
  const lastAction = live && device?.auto_switch_state?.last_action && device.auto_switch_state.last_action_at
    ? `last ${device.auto_switch_state.last_action.replace("switch:", "switched to ")} ${formatAgo(now - device.auto_switch_state.last_action_at)}`
    : null;

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
            {lastAction && <span className="text-sol-text-dim/70"> · {lastAction}</span>}
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
                onClick={() => void switchAndContinue()}
                disabled={busy}
                title={`Switch ${device?.label ?? "the owner machine"} to ${best?.email ?? best?.name}, restart this session, and continue it there`}
                className="rounded border border-amber-500/40 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 disabled:opacity-60"
              >
                {busy ? "Switching…" : `Continue on ${best?.name}${bestPct != null ? ` (${Math.round(bestPct)}% used)` : ""}`}
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
