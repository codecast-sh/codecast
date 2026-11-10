"use client";

// Guided setup for a cloud agent provider whose credential is an API key from
// Provider Keys (Cursor Cloud, the OpenAI Agents API). A key is made by hand
// on the vendor's site, so the dialog walks the person through that page,
// takes the pasted key, seals it to the machine that drives the agents (the
// browser cannot reach the vendor's API), and shows that machine's verdict:
// the account the key belongs to, or the vendor's reason for refusing it. A
// refused key is never stored. A key the vendor knows but limits is stored
// (other tools on the machine use it too), and the dialog says what it still
// needs. Each provider brings only its copy (KEY_SETUP); the vendor's name
// comes from its spec.

import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS, getProviderKeySpec, type CloudAgentProviderId } from "@codecast/shared/contracts";
import { useVerifiedKeySubmit } from "../../lib/useProviderKeyCommand";
import { Spinner, Step } from "../MintTokenDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CloudConnectDialog } from "./CloudConnectDialog";
import { useCloudAgentConnected } from "./credentials";
import { usePinnedCloudAgentMachine } from "./machine";
import { CloudAgentConnectedSync, CloudAgentRepoAccessLink } from "./parts";

/** What a key-based provider's dialog says. `machine` is the computer that drives its agents. */
interface KeySetupCopy {
  description: (machine: string) => ReactNode;
  /** Step 1: whose account to open the keys page in. */
  open: string;
  /** Step 2: how to make the key there. */
  create: ReactNode;
  /** Under the steps: what else the agents need, before the link to where repository access is given. */
  footer: string;
}

const em = (t: string) => <span className="text-sol-text">{t}</span>;

/** A provider whose credential is a Provider Keys entry (its spec names a keyProvider); its copy is in KEY_SETUP. */
export type KeyProviderId = { [K in CloudAgentProviderId]: (typeof CLOUD_AGENT_PROVIDERS)[K] extends { keyProvider: string } ? K : never }[CloudAgentProviderId];

const KEY_SETUP: Record<KeyProviderId, KeySetupCopy> = {
  cursor: {
    description: (machine) => <>Cursor Cloud sessions run on Cursor's machines against your GitHub repos. Codecast drives them from {machine} with a Cursor API key.</>,
    open: "Open Cursor's API keys page, signed in to the Cursor account the agents should run on.",
    create: <>Under {em("User API Keys")} press {em("Add")}, name it {em("codecast")}, press {em("Save")}, and copy the key. Cursor shows it once.</>,
    footer: "Agents only reach repos Cursor's GitHub app can see. Connect it under",
  },
  codex_api: {
    description: (machine) => <>Codex sessions on the OpenAI Agents API run on OpenAI's machines. Codecast drives them from {machine} with an OpenAI API key, which other tools on that machine that use one (opencode, pi) use too.</>,
    open: "Open OpenAI's API keys page, in the organization and project the sessions should bill to.",
    create: <>Press {em("Create new secret key")}, name it {em("codecast")}, and give it {em("All")} permissions (or, restricted: {em("Agents")} read and write, and {em("Responses")} write). Copy the key; OpenAI shows it once.</>,
    footer: `${CLOUD_AGENT_PROVIDERS.codex_api.lane.detail} See`,
  },
};

/** The guided key dialog for one such provider. */
export function ConnectKeyDialog({ provider, onClose, deviceId }: { provider: KeyProviderId; onClose: () => void; deviceId?: string | null }) {
  const spec = CLOUD_AGENT_PROVIDERS[provider];
  const copy = KEY_SETUP[provider];
  const keySpec = getProviderKeySpec(spec.keyProvider)!;
  const vendor = spec.vendor;
  const aKey = `${/^[aeiou]/i.test(vendor) ? "an" : "a"} ${vendor} key`;
  const { device, connected, machine, pubkey } = usePinnedCloudAgentMachine(deviceId, useCloudAgentConnected(spec));
  const { key, setKey, looksRight, submit, sent, checking, done, account, detail, failed } = useVerifiedKeySubmit(keySpec.id, device, pubkey);
  const [opened, setOpened] = useState(false);
  const trimmed = key.trim();
  const page = new URL(keySpec.consoleUrl);

  const openConsole = () => {
    window.open(keySpec.consoleUrl, "_blank", "noopener,noreferrer");
    setOpened(true);
  };

  const step1 = opened || trimmed || sent ? "done" : "active";
  const step2 = sent && !failed ? "done" : opened || trimmed ? "active" : "todo";
  const step3 = done ? "done" : checking || failed ? "active" : "todo";

  return (
    <CloudConnectDialog
      title={`Connect ${vendor}`}
      description={copy.description(machine)}
      device={device}
      machine={machine}
      pubkey={pubkey}
      done={done}
      onClose={onClose}
    >
      {connected && !sent && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          {machine} already has {aKey}. Adding another replaces it.
        </p>
      )}
      <ol className="space-y-3 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
        <Step n={1} state={step1}>
          {copy.open}
          <span className="mt-1.5 block">
            <Button type="button" size="sm" variant="outline" onClick={openConsole} className="h-7 gap-1.5 px-2.5 text-[11px]">
              Open {page.host}{page.pathname} <ExternalLink className="h-3 w-3" aria-hidden />
            </Button>
          </span>
        </Step>
        <Step n={2} state={step2}>
          {copy.create}
          <form className="mt-1.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Input
              aria-label={`${keySpec.label} API key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={`${keySpec.keyPrefix ?? ""}…`}
              className="h-8 font-mono"
            />
            <Button type="submit" size="sm" disabled={!looksRight || checking} className="h-8">
              {checking ? "Checking…" : "Connect"}
            </Button>
          </form>
          {trimmed && !looksRight && keySpec.keyPrefix && (
            <span className="mt-1 block text-[11px] text-amber-500">{aKey[0].toUpperCase()}{aKey.slice(1)} starts with {keySpec.keyPrefix}.</span>
          )}
        </Step>
        <Step n={3} state={step3}>
          Codecast checks the key with {vendor} on {machine} and keeps it there. It crosses codecast's servers only sealed to that machine.
          {checking && <Spinner label={`checking with ${vendor}`} className="mt-1" />}
        </Step>
      </ol>

      {failed && (
        <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">{failed}</p>
      )}
      {done && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          Connected{account ? ` as ${account}` : ""}. Sessions you start on {spec.label} now run from {machine}.
        </p>
      )}
      {done && <CloudAgentConnectedSync spec={spec} onNavigate={onClose} />}
      {done && detail && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-500">{detail}</p>
      )}
      <p className="text-[11px] text-sol-text-dim">{copy.footer} <CloudAgentRepoAccessLink spec={spec} className="hover:text-sol-text" />.</p>
    </CloudConnectDialog>
  );
}
