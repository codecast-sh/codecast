// The one manual recovery for a session parked on a usage limit: continue it
// on the freshest OTHER saved account with room left, by the same rule
// auto-switch chooses from (fallbackProfiles). When the machine has proposed a
// target, that proposal is the account. Web's park card and the phone's
// recovery banner both read and act through here.

import { fleetAccount, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { classifyApiErrorBanner, fallbackProfiles, modelLimitFamily, pendingProposal } from "@codecast/shared/contracts";
import { commitModelChange } from "./modelSwitch";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { requestAccountSwitchCommand } from "./sessionCommands";

export type LimitProfile = { name: string; email?: string; usage?: CcUsage; login_expired_at?: number; setup_token?: { stored_at: number; expires_at: number } };

/** The account the session ran on (fleet), and the best other one to continue on. */
export function limitContinueTarget(device: any, now: number, live: boolean): { fleetEmail?: string; active?: LimitProfile; best?: LimitProfile } {
  const profiles: LimitProfile[] = device?.profiles ?? [];
  const fleetEmail = fleetAccount(device, now).email;
  const active = profiles.find((p) => p.email && p.email === fleetEmail);
  // Only while the park is live: a settled session's old proposal is history.
  const proposal = live && device ? pendingProposal([device], now) : null;
  const eligible = fallbackProfiles(profiles, fleetEmail, now);
  const proposed = proposal?.target_email ? eligible.find((p) => p.email === proposal.target_email) : undefined;
  return { fleetEmail, active, best: proposed ?? eligible[0] };
}

/** The model family a limit-parked session's newest banner names when only
 *  that model's week is out ("fable"), else undefined. Reads the messages the
 *  store holds for it. */
export function parkedModelFamily(messages: ReadonlyArray<{ role?: string; content?: unknown }> | undefined): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i];
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    return classifyApiErrorBanner(m.content) === "limit" ? modelLimitFamily(m.content) : undefined;
  }
  return undefined;
}

/** The model to continue on when `family`'s week is out. */
export function otherModelFor(family: string): { key: string; label: string } {
  return family === "opus" ? { key: "sonnet", label: "Sonnet" } : { key: "opus", label: "Opus" };
}

/**
 * Continue a session parked on one model's limit on another model. Every
 * account shares the spent model's week state, so no account switch helps.
 * The parked agent sits idle at its prompt, so /model runs before the
 * continue; both ride the outbox in order.
 */
export function continueOnModel(conversationId: string, model: string, notify: (message: string) => void): void {
  const s = useInboxStore.getState();
  const row = s.conversations[conversationId] ?? s.sessions[conversationId];
  void commitModelChange({
    conversationId,
    agentType: row?.agent_type,
    current: { model: row?.model, effort: row?.effort },
    sel: { model },
    blank: false,
    notify,
  });
  const clientId = s.addOptimisticMessage(conversationId, "continue");
  s.sendMessage(conversationId, "continue", undefined, clientId);
}

/**
 * Continue one session on `best`: paint the "continue" it is about to receive,
 * stamp it revive-in-flight, and hand the daemon the same client id so the
 * echo replaces the painted bubble. A refusal takes the paint back.
 */
export function continueOnAccount(conversationId: string, best: { name: string; email?: string }): void {
  if (!best.email) return;
  const store = useInboxStore.getState();
  const clientId = `acct-revive-${Math.random().toString(36).slice(2, 10)}-${conversationId}`;
  store.addOptimisticMessage(conversationId, "continue", undefined, clientId);
  store.markBlockedReviveRequested([conversationId]);
  requestAccountSwitchCommand({
    email: best.email,
    conversation_ids: [conversationId],
    include_subagents: true,
    continue_client_ids: { [conversationId]: clientId },
  }, { profile: best.name }).catch((err: unknown) => {
    if (isParkedDispatchError(err)) return;
    store.removeOptimisticMessage(conversationId, clientId);
    store.clearBlockedReviveRequested([conversationId]);
  });
}
