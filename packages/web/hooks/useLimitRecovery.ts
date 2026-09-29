"use client";

// Where one conversation's usage-limit park stands (lib/limitRecovery), read
// from the owner machine's recovery record, the revive this browser asked for,
// and the delivery of the recovery's "continue". The park card and the
// composer's status line both read it, so they never disagree about whether
// the session is parked or already on its way back.

import { api } from "@codecast/convex/convex/_generated/api";
import { useCoarseNow } from "./useCoarseNow";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useInboxStore } from "../store/inboxStore";
import { RESUMED_MATCH_MS, limitRecoveryAction, limitRecoveryPhase } from "../lib/limitRecovery";

export function useLimitRecovery(
  conversationId: string | undefined,
  parkedAt: number | undefined,
  live: boolean,
  localTarget?: string,
) {
  const now = useCoarseNow(30_000);
  const ownerDeviceId = useInboxStore((s) => (conversationId ? s.sessions[conversationId]?.owner_device_id : undefined));
  const reviveRequestedAt = useInboxStore((s) => (conversationId ? s.blockedReviveRequestedAt[conversationId] : undefined));
  // The newest queued-or-settled message on the conversation (fed while the
  // thread is open): a "continue" that landed after the recovery acted means
  // the restarted session has it and is picking the turn back up.
  const pending = useInboxStore((s) => (conversationId ? (s.pendingMessageStatus as Record<string, any>)[conversationId] : undefined));
  // A settled park is read too while it is recent, to say how it resumed.
  const recent = parkedAt != null && now - parkedAt < RESUMED_MATCH_MS;
  // Enrichment only: without it a park still says what closed and when it
  // opens, so a backend that cannot serve the roster costs the recovery
  // narration, never the park.
  const { data } = useQueryNoThrow(api.accountSwitch.listAccountProfiles, parkedAt != null && (live || recent) ? {} : "skip");
  const devices = data?.devices ?? [];
  const device = devices.find((d) => d.device_id === ownerDeviceId) ?? devices.find((d) => !d.is_remote && d.online);
  const state = device?.auto_switch_state;
  const found = limitRecoveryAction({
    parkedAt,
    lastAction: state?.last_action,
    lastActionAt: state?.last_action_at,
    decision: state?.last_decision,
    localRequestAt: reviveRequestedAt,
    localTarget,
  });
  // Name the target by its saved profile when the record carried only an email.
  const action = found && {
    ...found,
    target: device?.profiles?.find((p) => p.email === found.target)?.name ?? found.target,
  };
  const continueDelivered = !!action && pending?.status === "delivered" &&
    String(pending.content ?? "").trim().toLowerCase() === "continue" &&
    (pending.created_at ?? 0) >= action.at - 5_000;
  return { now, device, phase: limitRecoveryPhase({ live, parkedAt, action, continueDelivered }) };
}
