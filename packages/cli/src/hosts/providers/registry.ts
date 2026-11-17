import type { CloudHost } from "../../browser/cloudHost.js";
import { awsProvider } from "./aws.js";
import { codecastProvider } from "./codecast.js";
import { scalewayMacProvider } from "./scalewayMac.js";
import type { HostProvider } from "./types.js";

const PROVIDERS: Record<CloudHost["provider"], HostProvider> = {
  aws: awsProvider,
  codecast: codecastProvider,
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

export function isMacHost(host: { platform?: string; provider?: string }): boolean {
  return host.platform === "darwin" || findProvider(host)?.macOnly === true;
}
