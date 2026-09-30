// The web's side of each cloud agent provider (CLOUD_AGENT_PROVIDERS in the
// shared contracts): its connect wording and the dialog that connects it.
// The components in ./index.tsx read it, so a new provider is an entry here.
import type { ComponentType } from "react";
import { cloudAgentProviderForKey, type CloudAgentProviderId, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { ConnectCursorDialog } from "../ConnectCursorDialog";
import { ConnectCodexDialog } from "./ConnectCodexDialog";

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
