"use client";

// The web's side of each cloud agent provider (CLOUD_AGENT_PROVIDERS in the
// shared contracts): its connect wording and the dialog that connects it
// (whether a machine is connected is credentials.ts). Everything else (the
// header chip, the composer's cloud switch, the credential card, the Sync
// switch) reads the shared registry, so a new provider is an entry here and
// there, not new JSX.

import { useState, type ComponentType } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS, cloudAgentProviderForKey, cloudAgentProviderForSyncSource, cloudAgentProviderOfSession, type CloudAgentProviderId, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { ConnectCursorDialog } from "../ConnectCursorDialog";
import { ConnectCodexDialog } from "./ConnectCodexDialog";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { useInboxStore } from "../../store/inboxStore";
import { useCloudAgentMachine } from "./CloudConnectDialog";
import { useCloudAgentConnected, useCloudAgentExpiry } from "./credentials";

interface CloudAgentUiEntry {
  /** What the connect control names: "Cursor". */
  connectName: string;
  /** What a held message waits for, given the machine that runs the session: "the key is connected". */
  heldUntil: (machine: string) => string;
  Dialog: ComponentType<{ onClose: () => void; deviceId?: string | null }>;
  /** A sign-in based provider's line among the Provider Keys: what it signs in with instead of a key. */
  signIn?: string;
}

export interface CloudAgentUi extends CloudAgentUiEntry {
  /** The connect control's words: "Connect Cursor". */
  connectLabel: string;
  /** The same inside a line of lowercase controls (the composer's switches). */
  connectInlineLabel: string;
}

const ENTRIES: Record<CloudAgentProviderId, CloudAgentUiEntry> = {
  cursor: { connectName: "Cursor", heldUntil: () => "the key is connected", Dialog: ConnectCursorDialog },
  codex: {
    connectName: "Codex",
    heldUntil: (machine) => `${machine} is signed in to Codex`,
    Dialog: ConnectCodexDialog,
    signIn: "Codex Cloud runs with this machine's Codex sign-in (your ChatGPT plan), not a key.",
  },
};

const CLOUD_AGENT_UI = Object.fromEntries(Object.entries(ENTRIES).map(([id, e]) => [id, {
  ...e,
  connectLabel: `Connect ${e.connectName}`,
  connectInlineLabel: `connect ${e.connectName}`,
}])) as Record<CloudAgentProviderId, CloudAgentUi>;

export function cloudAgentUi(spec: CloudAgentProviderSpec): CloudAgentUi {
  return CLOUD_AGENT_UI[spec.id as CloudAgentProviderId];
}

/** The guided setup for a Provider Keys entry that is a cloud agent's credential. */
export function cloudAgentKeyDialog(keyProvider: string): CloudAgentUi["Dialog"] | undefined {
  const spec = cloudAgentProviderForKey(keyProvider);
  return spec ? cloudAgentUi(spec).Dialog : undefined;
}

/**
 * The machine that drives a provider's session, whether it is connected
 * (never, without a provider), and when its sign-in ran out if that is why not.
 */
export function useCloudAgentStatus(spec: CloudAgentProviderSpec | undefined, deviceId?: string | null): { device: Device | null; connected: boolean; expiredAt?: number } {
  const status = useCloudAgentMachine(deviceId, useCloudAgentConnected(spec));
  const expiry = useCloudAgentExpiry(spec);
  const expiredAt = status.device ? expiry(status.device) : undefined;
  return expiredAt ? { ...status, expiredAt } : status;
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A held message's line on a session's credential card: what it waits for, on the machine that runs the session. */
export function CloudAgentHeldNote({ spec, conversationId }: { spec: CloudAgentProviderSpec; conversationId?: string }) {
  const { device } = useCloudAgentStatus(spec, useLiveSessionMeta(conversationId)?.ownerDeviceId);
  return <span>Your message is held and goes out as soon as {cloudAgentUi(spec).heldUntil(device?.label ?? "your computer")}.</span>;
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

/** The sign-in based providers, listed with the Provider Keys: each one's state on the machine and its connect dialog. */
export function CloudAgentSignInRows({ deviceId }: { deviceId: string }) {
  return <>{Object.values(CLOUD_AGENT_PROVIDERS).filter((spec) => cloudAgentUi(spec).signIn).map((spec) => <CloudAgentSignInRow key={spec.id} spec={spec} deviceId={deviceId} />)}</>;
}

function CloudAgentSignInRow({ spec, deviceId }: { spec: CloudAgentProviderSpec; deviceId: string }) {
  const { connected, expiredAt } = useCloudAgentStatus(spec, deviceId);
  const { connectName, signIn } = cloudAgentUi(spec);
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap sm:px-5">
      <div className="min-w-0">
        <span className="text-sm text-sol-text">{spec.label}</span>
        <p className="mt-0.5 text-xs text-sol-text-muted">{signIn}</p>
        {expiredAt && <p className="mt-0.5 text-xs text-amber-500">The sign-in expired {shortDate(expiredAt)}.</p>}
      </div>
      <ConnectCloudAgentButton spec={spec} deviceId={deviceId} label={connected ? `${connectName} connected` : undefined} />
    </div>
  );
}

/** Under an account sync switch whose provider's sign-in ran out on your computer: the sync is paused until it signs in again. */
export function CloudAgentSyncNote({ source }: { source: string }) {
  const spec = cloudAgentProviderForSyncSource(source) ?? undefined;
  const { device, expiredAt } = useCloudAgentStatus(spec);
  if (!spec || !device || !expiredAt) return null;
  return (
    <span className="mt-1 block text-amber-500">
      The {cloudAgentUi(spec).connectName} sign-in on {device.label ?? "your computer"} expired {shortDate(expiredAt)}. Sync is paused until you sign in again.
    </span>
  );
}

/** Beside an account sync switch whose source is a cloud agent provider: its connect dialog, saying whether your computer is connected. */
export function CloudAgentSyncConnect({ source }: { source: string }) {
  const spec = cloudAgentProviderForSyncSource(source) ?? undefined;
  const { connected } = useCloudAgentStatus(spec);
  if (!spec) return null;
  return <ConnectCloudAgentButton spec={spec} label={connected ? `${cloudAgentUi(spec).connectName} connected` : undefined} />;
}

/** The cloud agent a conversation runs as (its session id is the agent's id), or null for a local session. */
export function useCloudAgentOfConversation(conversationId: string | undefined): { spec: CloudAgentProviderSpec; sessionId: string } | null {
  // Per field across the conversation row and the session row: a conversation
  // row can be a stub holding only its _id while the session row has both.
  type Row = { agent_type?: string; session_id?: string } | undefined;
  const field = <K extends keyof NonNullable<Row>>(st: ReturnType<typeof useInboxStore.getState>, k: K) => {
    if (!conversationId) return undefined;
    const key = st.resolveLiveSessionId(conversationId);
    return (st.conversations[key] as Row)?.[k] ?? (st.sessions[key] as Row)?.[k];
  };
  const agentType = useInboxStore((st) => field(st, "agent_type"));
  const sessionId = useInboxStore((st) => field(st, "session_id"));
  const spec = cloudAgentProviderOfSession(agentType, sessionId);
  return spec && sessionId ? { spec, sessionId } : null;
}

/** The cloud agent behind a session, opened on the provider's site. */
export function CloudAgentLink({ conversationId }: { conversationId: string }) {
  const cloud = useCloudAgentOfConversation(conversationId);
  if (!cloud) return null;
  const { spec, sessionId } = cloud;
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
