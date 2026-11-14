"use client";

// The Claude or Codex account a session is spending, as a fact in the header
// and a non-action line in the session menus. The subscription is its own
// so a usage poll on the machine's profile list does not re-render the model
// control: the selector returns only the three strings the line shows.

import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../../store/inboxStore";
import { settingsDataKey } from "../../lib/settingsData";
import {
  sessionAccountLabel,
  sessionAccountLine,
  type SessionAccountLabel,
  type SessionAccountProfile,
} from "../../lib/sessionAccountLabel";
import { cn } from "../../lib/utils";

type AccountDevice = {
  device_id: string;
  active_email?: string | null;
  launch_profile?: string | null;
  profiles?: SessionAccountProfile[] | null;
  codex_accounts?: { active_email?: string | null; profiles?: SessionAccountProfile[] | null } | null;
};

function field<T>(conv: Record<string, unknown> | undefined, sess: Record<string, unknown> | undefined, key: string): T | undefined {
  if (conv && Object.prototype.hasOwnProperty.call(conv, key)) return conv[key] as T;
  return sess?.[key] as T | undefined;
}

function useSessionAccount(conversationId: string | undefined): SessionAccountLabel | null {
  return useInboxStore(useShallow((s) => {
    if (!conversationId) return null;
    const id = s.resolveLiveSessionId(conversationId);
    const sess = s.sessions[id] as Record<string, unknown> | undefined;
    const conv = s.conversations[id] as Record<string, unknown> | undefined;
    if (!sess && !conv) return null;
    const userId = (s.currentUser as { _id?: unknown } | null)?._id;
    const key = settingsDataKey("accountProfiles", userId ? String(userId) : null);
    const devices = (key
      ? (s.settingsData as Record<string, { value?: { devices?: AccountDevice[] } } | undefined>)[key]?.value?.devices
      : undefined) ?? [];
    const owner = field<string | null>(conv, sess, "owner_device_id");
    const device = owner ? devices.find((d) => d.device_id === owner) : undefined;
    return sessionAccountLabel({
      agentType: field<string>(conv, sess, "agent_type"),
      sessionId: field<string>(conv, sess, "session_id"),
      model: field<string | null>(conv, sess, "model"),
      ccAccount: field<string | null>(conv, sess, "cc_account"),
      codexAccount: field<string | null>(conv, sess, "codex_account"),
      claude: device
        ? { activeEmail: device.active_email, launchProfile: device.launch_profile, profiles: device.profiles }
        : null,
      codex: device?.codex_accounts
        ? { activeEmail: device.codex_accounts.active_email, profiles: device.codex_accounts.profiles }
        : null,
    });
  }));
}

/** Dim fact beside the agent and model, which already name the provider. */
export function SessionAccountFact({ conversationId }: { conversationId?: string }) {
  const account = useSessionAccount(conversationId);
  if (!account) return null;
  return (
    <span className="max-w-[9rem] truncate" title={account.title} data-session-account={account.provider}>
      {account.label}
    </span>
  );
}

/** Non-action line in a session menu. Renders nothing when the session names no account. */
export function SessionAccountLine({ conversationId, className }: { conversationId?: string; className?: string }) {
  const account = useSessionAccount(conversationId);
  if (!account) return null;
  return (
    <div className={cn("truncate px-2 py-1 text-xs text-sol-text-muted", className)} title={account.title}>
      {sessionAccountLine(account)}
    </div>
  );
}
