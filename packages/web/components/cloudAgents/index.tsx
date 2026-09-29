"use client";

// The web's side of each cloud agent provider (CLOUD_AGENT_PROVIDERS in the
// shared contracts): its connect wording and the dialog that connects it
// (whether a machine is connected is credentials.ts). Everything else (the
// header chip, the composer's cloud switch, the credential card, the Sync
// switch) reads the shared registry, so a new provider is an entry here and
// there, not new JSX.

import { useState, type ComponentType } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS, cloudAgentProviderOfSession, type CloudAgentProviderId, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { ConnectCursorDialog } from "../ConnectCursorDialog";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { useInboxStore } from "../../store/inboxStore";
import { useCloudAgentMachine } from "./CloudConnectDialog";
import { cloudAgentConnected } from "./credentials";

export interface CloudAgentUi {
  /** The connect control's words: "Connect Cursor". */
  connectLabel: string;
  /** The same inside a line of lowercase controls (the composer's switches). */
  connectInlineLabel: string;
  /** What a held message waits for: "the key is connected". */
  heldUntil: string;
  Dialog: ComponentType<{ onClose: () => void; deviceId?: string | null }>;
}

const CLOUD_AGENT_UI: Record<CloudAgentProviderId, CloudAgentUi> = {
  cursor: { connectLabel: "Connect Cursor", connectInlineLabel: "connect Cursor", heldUntil: "the key is connected", Dialog: ConnectCursorDialog },
};

export function cloudAgentUi(spec: CloudAgentProviderSpec): CloudAgentUi {
  return CLOUD_AGENT_UI[spec.id as CloudAgentProviderId];
}

/** The guided setup for a Provider Keys entry that is a cloud agent's credential. */
export function cloudAgentKeyDialog(keyProvider: string): CloudAgentUi["Dialog"] | undefined {
  const spec = Object.values(CLOUD_AGENT_PROVIDERS).find((s) => s.keyProvider === keyProvider);
  return spec ? cloudAgentUi(spec).Dialog : undefined;
}

const NEVER_CONNECTED = () => false;

/** The machine that drives a provider's session, and whether it is connected (never, without a provider). */
export function useCloudAgentStatus(spec: CloudAgentProviderSpec | undefined, deviceId?: string | null): { device: Device | null; connected: boolean } {
  return useCloudAgentMachine(deviceId, spec ? cloudAgentConnected(spec) : NEVER_CONNECTED);
}

/** A small control that opens the provider's connect dialog. */
export function ConnectCloudAgentButton({ spec, label, className, deviceId, conversationId }: { spec: CloudAgentProviderSpec; label?: string; className?: string; deviceId?: string | null; conversationId?: string }) {
  const [open, setOpen] = useState(false);
  // From a session: the credentials belong on the machine that runs it.
  const ownerDeviceId = useLiveSessionMeta(conversationId)?.ownerDeviceId;
  const { Dialog, connectLabel } = cloudAgentUi(spec);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 rounded border border-sol-violet/40 bg-sol-violet/10 px-1.5 py-0.5 text-[10px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/20 ${className ?? ""}`}
      >
        <KeyRound className="h-3 w-3" aria-hidden />
        {label ?? connectLabel}
      </button>
      {open && <Dialog deviceId={deviceId ?? ownerDeviceId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The cloud agent behind a session (its session id is the agent's id), opened on the provider's site. */
export function CloudAgentLink({ conversationId }: { conversationId: string }) {
  // Per field across the conversation row and the session row: a conversation
  // row can be a stub holding only its _id while the session row has both.
  type Row = { agent_type?: string; session_id?: string } | undefined;
  const field = <K extends keyof NonNullable<Row>>(st: ReturnType<typeof useInboxStore.getState>, k: K) => {
    const key = st.resolveLiveSessionId(conversationId);
    return (st.conversations[key] as Row)?.[k] ?? (st.sessions[key] as Row)?.[k];
  };
  const agentType = useInboxStore((st) => field(st, "agent_type"));
  const sessionId = useInboxStore((st) => field(st, "session_id"));
  const spec = cloudAgentProviderOfSession(agentType, sessionId);
  if (!spec || !sessionId) return null;
  const href = spec.agentUrl(sessionId);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`This session runs as a ${spec.label} agent: open it on ${new URL(href).host}`}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-sol-violet/30 px-1.5 py-px text-[10px] text-sol-violet hover:bg-sol-violet/10"
    >
      {spec.label} <ExternalLink className="h-2.5 w-2.5" aria-hidden />
    </a>
  );
}
