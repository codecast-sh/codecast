"use client";

// The web's side of each cloud agent provider (CLOUD_AGENT_PROVIDERS in the
// shared contracts): its connect wording and the dialog that connects it
// (whether a machine is connected is credentials.ts). Everything else (the
// header chip, the composer's cloud switch, the credential card, the Sync
// switch) reads the shared registry, so a new provider is an entry here and
// there, not new JSX.

import { useState, type ComponentType } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS, CLOUD_AGENT_RETRIED_SUFFIX, cloudAgentProviderForKey, cloudAgentProviderForSyncSource, cloudAgentProviderOfSession, cloudAgentSetupSentence, isCloudAgentCredentialKind, type CloudAgentProviderId, type CloudAgentProviderSpec, type CloudAgentSetupKind } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { ConnectCursorDialog } from "../ConnectCursorDialog";
import { ConnectCodexDialog } from "./ConnectCodexDialog";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { useCloudAgentMachine } from "./CloudConnectDialog";
import { cloudAgentBlockOf, useCloudAgentConnected, useCloudAgentExpiry } from "./credentials";

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

/** What keeps a machine from reading a provider, in the sentence the daemon's card says (cloudAgentSetupSentence), and what it waits for. */
export interface CloudAgentProblem {
  kind: CloudAgentSetupKind;
  sentence: string;
  /** A new key or sign-in fixes it (isCloudAgentCredentialKind). */
  credential: boolean;
}

/**
 * The machine that drives a provider's session, whether it is connected
 * (never, without a provider), and why not when it can say: its sign-in ran
 * out, or what its daemon found in the provider's way.
 */
export function useCloudAgentStatus(spec: CloudAgentProviderSpec | undefined, deviceId?: string | null): { device: Device | null; connected: boolean; problem?: CloudAgentProblem } {
  const status = useCloudAgentMachine(deviceId, useCloudAgentConnected(spec));
  const expiry = useCloudAgentExpiry(spec);
  if (!spec || !status.device) return status;
  const expiredAt = expiry(status.device);
  const block = expiredAt ? { kind: "key_invalid" as const, expiredAt } : cloudAgentBlockOf(spec, status.device);
  if (!block) return status;
  const sentence = cloudAgentSetupSentence(spec, block, status.device.label ?? "your computer");
  return { ...status, problem: { kind: block.kind, sentence, credential: isCloudAgentCredentialKind(block.kind) } };
}

/** What waits on a setup problem that is not a credential. */
const UNTIL_FIXED = "this is fixed";

/**
 * A setup card's sentence (cloudAgentSetupCard) without the retry clause the
 * card's own line says, and the page it names where access is given as a link.
 */
export function CloudAgentSetupText({ spec, message }: { spec: CloudAgentProviderSpec; message: string }) {
  const text = message.trim().replace(CLOUD_AGENT_RETRIED_SUFFIX, ".");
  const at = text.indexOf(spec.repoAccessUrl);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <a href={spec.repoAccessUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 hover:opacity-80">
        {new URL(spec.repoAccessUrl).host}{new URL(spec.repoAccessUrl).pathname} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
      {text.slice(at + spec.repoAccessUrl.length)}
    </>
  );
}

/** A held message's line on a session's setup card (`credential`: a credential card), saying what it waits for on the machine that runs the session. */
export function CloudAgentHeldNote({ spec, credential, conversationId }: { spec: CloudAgentProviderSpec; credential: boolean; conversationId?: string }) {
  const { device } = useCloudAgentStatus(spec, useLiveSessionMeta(conversationId)?.ownerDeviceId);
  return <>Your message is held and goes out on its own as soon as {credential ? cloudAgentUi(spec).heldUntil(device?.label ?? "your computer") : UNTIL_FIXED}.</>;
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
  const { connected, problem } = useCloudAgentStatus(spec, deviceId);
  const { connectName, signIn } = cloudAgentUi(spec);
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap sm:px-5">
      <div className="min-w-0">
        <span className="text-sm text-sol-text">{spec.label}</span>
        <p className="mt-0.5 text-xs text-sol-text-muted">{signIn}</p>
        {/* No sign-in at all is what the Connect button says. */}
        {problem && problem.kind !== "key_missing" && <p className="mt-0.5 text-xs text-amber-500">{problem.sentence}</p>}
      </div>
      <ConnectCloudAgentButton spec={spec} deviceId={deviceId} label={connected ? `${connectName} connected` : undefined} />
    </div>
  );
}

/**
 * Under an account sync switch whose provider your computer cannot read: no
 * sign-in (said only while the switch is on), a sign-in that ran out or is
 * refused, or the provider refusing the account (Codex Cloud turned off for
 * the workspace). Nothing syncs until that changes.
 */
export function CloudAgentSyncNote({ source, on }: { source: string; on: boolean }) {
  const spec = cloudAgentProviderForSyncSource(source) ?? undefined;
  const { problem } = useCloudAgentStatus(spec);
  if (!spec || !problem || (problem.kind === "key_missing" && !on)) return null;
  // Beside the connect control: a credential problem is fixed by using it.
  return <span className="mt-1 block text-amber-500">{problem.sentence} Nothing syncs until {problem.credential ? `you ${cloudAgentUi(spec).connectInlineLabel}` : UNTIL_FIXED}.</span>;
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
  const live = useLiveSessionMeta(conversationId);
  const spec = cloudAgentProviderOfSession(live?.agentType, live?.sessionId);
  return spec && live?.sessionId ? { spec, sessionId: live.sessionId } : null;
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
      {/* A phone's header strip is short: the provider's mark says which cloud. */}
      <AgentTypeIcon agentType={spec.agentType} className="h-2.5 w-2.5 sm:hidden" />
      <span className="sm:hidden">Cloud</span>
      <span className="hidden sm:inline">{spec.label}</span>
      <ExternalLink className="h-2.5 w-2.5" aria-hidden />
    </a>
  );
}
