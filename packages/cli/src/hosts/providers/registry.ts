import type { CloudHost } from "../../browser/cloudHost.js";
import { awsProvider } from "./aws.js";
import { codecastProvider } from "./codecast.js";
import { namespaceProvider } from "./namespace.js";
import { scalewayMacProvider } from "./scalewayMac.js";
import type { HostProvider } from "./types.js";

const PROVIDERS: Record<CloudHost["provider"], HostProvider> = {
  aws: awsProvider,
  codecast: codecastProvider,
  namespace: namespaceProvider,
  "scaleway-mac": scalewayMacProvider,
};

function findProvider(host: { provider?: string }): HostProvider | undefined {
  const name = String(host.provider);
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name as CloudHost["provider"]] : undefined;
}

export function hostProvider(host: { provider?: string }): HostProvider {
  const found = findProvider(host);
  if (!found) {
    throw new Error(`unknown host provider "${String(host.provider)}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return found;
}

export function hostSleeps(host: { provider?: string }): boolean {
  return findProvider(host)?.start !== undefined;
}

export function hostHasSystemd(host: { provider?: string }): boolean {
  return findProvider(host)?.systemd !== false;
}

export function displayRefusal(host: { provider?: string }): string | undefined {
  if (findProvider(host)?.display !== false) return undefined;
  const name = String(host.provider);
  return `live view and the managed browser are not supported on ${name[0]!.toUpperCase()}${name.slice(1)} hosts yet`;
}

export function isMacHost(host: { platform?: string; provider?: string }): boolean {
  return host.platform === "darwin" || findProvider(host)?.macOnly === true;
}
