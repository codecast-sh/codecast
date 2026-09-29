"use client";

// The web's side of each cloud agent provider (CLOUD_AGENT_PROVIDERS in the
// shared contracts): how it is connected on a machine and the dialog that
// connects it. Everything else (the header chip, the composer's cloud switch,
// the credential card, the Sync switch) reads the shared registry, so a new
// provider is an entry here and there, not new JSX.

import { useState, type ComponentType } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS, cloudAgentProviderOfSession, type CloudAgentProviderId, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { ConnectCursorDialog } from "../ConnectCursorDialog";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { useInboxStore } from "../../store/inboxStore";
import { useCloudAgentMachine } from "./CloudConnectDialog";
import { hasCloudAgentKey } from "./credentials";

export interface CloudAgentUi {
  /** The connect control's words: "Connect Cursor". */
  connectLabel: string;
  /** Whether a machine can drive the provider's agents. */
  isConnected: (device: Device) => boolean;
  Dialog: ComponentType<{ onClose: () => void; deviceId?: string | null }>;
}

export const CLOUD_AGENT_UI: Record<CloudAgentProviderId, CloudAgentUi> = {
  cursor: { connectLabel: "Connect Cursor", isConnected: hasCloudAgentKey("cursor"), Dialog: ConnectCursorDialog },
};

function uiOf(spec: CloudAgentProviderSpec): CloudAgentUi {
  return CLOUD_AGENT_UI[spec.id as CloudAgentProviderId];
}

/** The guided setup for a Provider Keys entry that is a cloud agent's credential. */
export function cloudAgentKeyDialog(keyProvider: string): CloudAgentUi["Dialog"] | undefined {
  const spec = Object.values(CLOUD_AGENT_PROVIDERS).find((s) => s.keyProvider === keyProvider);
  return spec ? uiOf(spec).Dialog : undefined;
}

const NEVER_CONNECTED = () => false;

/** The machine that drives a provider's session, and whether it is connected (never, without a provider). */
export function useCloudAgentStatus(spec: CloudAgentProviderSpec | undefined, deviceId?: string | null): { device: Device | null; connected: boolean } {
  return useCloudAgentMachine(deviceId, spec ? uiOf(spec).isConnected : NEVER_CONNECTED);
}

/** A small control that opens the provider's connect dialog. */
export function ConnectCloudAgentButton({ spec, label, className, deviceId, conversationId }: { spec: CloudAgentProviderSpec; label?: string; className?: string; deviceId?: string | null; conversationId?: string }) {
  const [open, setOpen] = useState(false);
  // From a session: the credentials belong on the machine that runs it.
  const ownerDeviceId = useLiveSessionMeta(conversationId)?.ownerDeviceId;
  const { Dialog, connectLabel } = uiOf(spec);
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
  const row = (st: ReturnType<typeof useInboxStore.getState>) => {
    const key = st.resolveLiveSessionId(conversationId);
    return (st.conversations[key] ?? st.sessions[key]) as { agent_type?: string; session_id?: string } | undefined;
  };
  const agentType = useInboxStore((st) => row(st)?.agent_type);
  const sessionId = useInboxStore((st) => row(st)?.session_id);
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
