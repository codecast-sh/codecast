// Which of the person's computers drives a cloud agent, whether it can, and
// why not when it cannot say yes. A cloud agent is driven from a computer (the
// browser cannot reach the provider's API); whether that computer holds the
// credential is credentials.ts.
import { useState } from "react";
import { cloudAgentSetupSentence, isCloudAgentCredentialKind, type CloudAgentProviderSpec, type CloudAgentSetupKind } from "@codecast/shared/contracts";
import { useDevices, type Device } from "../DeviceBadge";
import { deviceManagedKeys } from "../../lib/useProviderKeyCommand";
import { cloudAgentBlockOf, useCloudAgentConnected, useCloudAgentExpiry } from "./credentials";

/** How a machine is named in cloud agent copy, before one is known too. */
export function machineName(device: Device | null | undefined): string {
  return device?.label ?? "your computer";
}

/**
 * The machine that drives a cloud agent session, and whether it is already
 * connected to the provider: the one named (the session's machine, the page's
 * machine), else your most recently seen online computer.
 */
export function useCloudAgentMachine(deviceId: string | null | undefined, isConnected: (device: Device) => boolean): { device: Device | null; connected: boolean } {
  const { byId, mostRecentOnlineLocal } = useDevices();
  const device = (deviceId ? byId.get(deviceId) : undefined) ?? mostRecentOnlineLocal;
  return { device, connected: !!device && isConnected(device) };
}

/**
 * The machine for a dialog, fixed when it opens: the roster reorders as
 * machines check in, and credentials must go where the label said.
 */
export function usePinnedCloudAgentMachine(deviceId: string | null | undefined, isConnected: (device: Device) => boolean) {
  const initial = useCloudAgentMachine(deviceId, isConnected);
  const [pinnedId] = useState(() => initial.device?.device_id ?? null);
  const { device, connected } = useCloudAgentMachine(pinnedId, isConnected);
  return { device, connected, machine: machineName(device), pubkey: device ? deviceManagedKeys(device).pubkey : undefined };
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
  const sentence = cloudAgentSetupSentence(spec, block, machineName(status.device));
  return { ...status, problem: { kind: block.kind, sentence, credential: isCloudAgentCredentialKind(block.kind) } };
}
