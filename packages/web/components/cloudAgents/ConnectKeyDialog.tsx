"use client";

// Guided setup for a cloud agent provider whose credential is an API key from
// Provider Keys (Cursor Cloud, the OpenAI Agents API). A key is made by hand
// on the vendor's site, so the dialog walks the person through that page,
// takes the pasted key, seals it to the machine that drives the agents (the
// browser cannot reach the vendor's API), and shows that machine's verdict:
// the account the key belongs to, or the vendor's reason for refusing it. A
// refused key is never stored. Each provider brings only its copy (KEY_SETUP).

import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { CLOUD_AGENT_BACKFILL_DAYS, CLOUD_AGENT_PROVIDERS, getProviderKeySpec, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { useVerifiedKeySubmit } from "../../lib/useProviderKeyCommand";
import { Spinner, Step } from "../MintTokenDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CloudConnectDialog } from "./CloudConnectDialog";
import { useCloudAgentConnected } from "./credentials";
import { usePinnedCloudAgentMachine } from "./machine";

/** What a key-based provider's dialog says. `machine` is the computer that drives its agents. */
interface KeySetupCopy {
  /** The vendor, as "checking with OpenAI" names it. */
  vendor: string;
  /** "a Cursor key". */
  aKey: string;
  description: (machine: string) => ReactNode;
  /** Step 1: whose account to open the keys page in. */
  open: string;
  /** Step 2: how to make the key there. */
  create: ReactNode;
  /** Once the machine has checked and kept the key. */
  connected: (machine: string) => string;
  /** Under the steps: what else the agents need. */
  footer: ReactNode;
}

const LINK = "underline decoration-dotted underline-offset-2 hover:text-sol-text";
const em = (t: string) => <span className="text-sol-text">{t}</span>;

const KEY_SETUP: Record<"cursor" | "codex_api", KeySetupCopy> = {
  cursor: {
    vendor: "Cursor",
    aKey: "a Cursor key",
    description: (machine) => <>Cursor Cloud sessions run on Cursor's machines against your GitHub repos. Codecast drives them from {machine} with a Cursor API key.</>,
    open: "Open Cursor's API keys page, signed in to the Cursor account the agents should run on.",
    create: <>Under {em("User API Keys")} press {em("Add")}, name it {em("codecast")}, press {em("Save")}, and copy the key. Cursor shows it once.</>,
    connected: (machine) => `Cursor Cloud sessions now run from ${machine}, and your cloud agents from the last ${CLOUD_AGENT_BACKFILL_DAYS} days appear in your inbox.`,
    footer: (
      <>
        Agents only reach repos Cursor's GitHub app can see. Connect it under{" "}
        <a href={CLOUD_AGENT_PROVIDERS.cursor.repoAccessUrl} target="_blank" rel="noreferrer" className={LINK}>Cursor → Integrations</a>.
      </>
    ),
  },
  codex_api: {
    vendor: "OpenAI",
    aKey: "an OpenAI key",
    description: (machine) => <>Codex sessions on the OpenAI Agents API run on OpenAI's machines, billed to an OpenAI API key at the model's API rates plus sandbox time. Codecast drives them from {machine} with that key, which clients there that read OPENAI_API_KEY use too.</>,
    open: "Open OpenAI's API keys page, in the organization and project the sessions should bill to.",
    create: <>Press {em("Create new secret key")}, name it {em("codecast")}, and give it {em("All")} permissions (or, restricted: {em("Agents")} read and write, and {em("Responses")} write). Copy the key; OpenAI shows it once.</>,
    connected: (machine) => `Codex sessions you start on the OpenAI Agents API now run from ${machine}.`,
    footer: (
      <>
        Each session runs in an OpenAI-hosted sandbox that clones the session's repository from GitHub without credentials, so it reaches
        public repositories and can't push. See{" "}
        <a href={CLOUD_AGENT_PROVIDERS.codex_api.repoAccessUrl} target="_blank" rel="noreferrer" className={LINK}>OpenAI-hosted sandboxes</a>.
      </>
    ),
  },
};

function ConnectKeyDialog({ spec, copy, onClose, deviceId }: { spec: CloudAgentProviderSpec; copy: KeySetupCopy; onClose: () => void; deviceId?: string | null }) {
  const keySpec = getProviderKeySpec(spec.keyProvider!)!;
  const { device, connected, machine, pubkey } = usePinnedCloudAgentMachine(deviceId, useCloudAgentConnected(spec));
  const { key, setKey, looksRight, submit, sent, checking, done, account, failed } = useVerifiedKeySubmit(keySpec.id, device, pubkey);
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
      title={`Connect ${copy.vendor}`}
      description={copy.description(machine)}
      device={device}
      machine={machine}
      pubkey={pubkey}
      done={done}
      onClose={onClose}
    >
      {connected && !sent && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          {machine} already has {copy.aKey}. Adding another replaces it.
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
            <span className="mt-1 block text-[11px] text-amber-500">{copy.aKey[0].toUpperCase()}{copy.aKey.slice(1)} starts with {keySpec.keyPrefix}.</span>
          )}
        </Step>
        <Step n={3} state={step3}>
          Codecast checks the key with {copy.vendor} on {machine} and keeps it there. It crosses codecast's servers only sealed to that machine.
          {checking && <Spinner label={`checking with ${copy.vendor}`} className="mt-1" />}
        </Step>
      </ol>

      {failed && (
        <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">{failed}</p>
      )}
      {done && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          Connected{account ? ` as ${account}` : ""}. {copy.connected(machine)}
        </p>
      )}
      <p className="text-[11px] text-sol-text-dim">{copy.footer}</p>
    </CloudConnectDialog>
  );
}

export function ConnectCursorDialog(props: { onClose: () => void; deviceId?: string | null }) {
  return <ConnectKeyDialog spec={CLOUD_AGENT_PROVIDERS.cursor} copy={KEY_SETUP.cursor} {...props} />;
}

export function ConnectOpenAIDialog(props: { onClose: () => void; deviceId?: string | null }) {
  return <ConnectKeyDialog spec={CLOUD_AGENT_PROVIDERS.codex_api} copy={KEY_SETUP.codex_api} {...props} />;
}
