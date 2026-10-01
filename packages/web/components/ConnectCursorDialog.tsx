"use client";

// Guided setup for the Cursor API key Cursor Cloud sessions run on. Cursor has
// no OAuth for its API: a key is made by hand on cursor.com. So the dialog
// walks the person through that page, takes the pasted key, seals it to the
// machine that drives the cloud agents (the browser cannot reach
// api.cursor.com), and shows that machine's verdict: the Cursor account the
// key belongs to, or Cursor's reason for refusing it. A refused key is never
// stored.

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { CLOUD_AGENT_BACKFILL_DAYS, CLOUD_AGENT_PROVIDERS, getProviderKeySpec } from "@codecast/shared/contracts";
import { useVerifiedKeySubmit } from "../lib/useProviderKeyCommand";
import { Spinner, Step } from "./MintTokenDialog";
import { CloudConnectDialog } from "./cloudAgents/CloudConnectDialog";
import { usePinnedCloudAgentMachine } from "./cloudAgents/machine";
import { useCloudAgentConnected } from "./cloudAgents/credentials";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const CURSOR = getProviderKeySpec("cursor")!;

export function ConnectCursorDialog({ onClose, deviceId }: { onClose: () => void; deviceId?: string | null }) {
  const { device, connected, machine, pubkey } = usePinnedCloudAgentMachine(deviceId, useCloudAgentConnected(CLOUD_AGENT_PROVIDERS.cursor));
  const { key, setKey, looksRight, submit, sent, checking, done, account, failed } = useVerifiedKeySubmit("cursor", device, pubkey);
  const [opened, setOpened] = useState(false);
  const trimmed = key.trim();

  const openCursor = () => {
    window.open(CURSOR.consoleUrl, "_blank", "noopener,noreferrer");
    setOpened(true);
  };

  const step1 = opened || trimmed || sent ? "done" : "active";
  const step2 = sent && !failed ? "done" : opened || trimmed ? "active" : "todo";
  const step3 = done ? "done" : checking || failed ? "active" : "todo";

  return (
    <CloudConnectDialog
      title="Connect Cursor"
      description={<>Cursor Cloud sessions run on Cursor's machines against your GitHub repos. Codecast drives them from {machine} with a Cursor API key.</>}
      device={device}
      machine={machine}
      pubkey={pubkey}
      done={done}
      onClose={onClose}
    >
      {connected && !sent && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          {machine} already has a Cursor key. Adding another replaces it.
        </p>
      )}
      <ol className="space-y-3 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
        <Step n={1} state={step1}>
          Open Cursor's API keys page, signed in to the Cursor account the agents should run on.
          <span className="mt-1.5 block">
            <Button type="button" size="sm" variant="outline" onClick={openCursor} className="h-7 gap-1.5 px-2.5 text-[11px]">
              Open cursor.com/dashboard/api <ExternalLink className="h-3 w-3" aria-hidden />
            </Button>
          </span>
        </Step>
        <Step n={2} state={step2}>
          Under <span className="text-sol-text">User API Keys</span> press <span className="text-sol-text">Add</span>, name it{" "}
          <span className="text-sol-text">codecast</span>, press <span className="text-sol-text">Save</span>, and copy the key. Cursor shows it once.
          <form className="mt-1.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Input
              aria-label="Cursor API key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={`${CURSOR.keyPrefix}…`}
              className="h-8 font-mono"
            />
            <Button type="submit" size="sm" disabled={!looksRight || checking} className="h-8">
              {checking ? "Checking…" : "Connect"}
            </Button>
          </form>
          {trimmed && !looksRight && (
            <span className="mt-1 block text-[11px] text-amber-500">A Cursor key starts with {CURSOR.keyPrefix}.</span>
          )}
        </Step>
        <Step n={3} state={step3}>
          Codecast checks the key with Cursor on {machine} and keeps it there. It crosses codecast's servers only sealed to that machine.
          {checking && <Spinner label="checking with Cursor" className="mt-1" />}
        </Step>
      </ol>

      {failed && (
        <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">{failed}</p>
      )}
      {done && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          Connected{account ? ` as ${account}` : ""}. Cursor Cloud sessions now run from {machine}, and your
          cloud agents from the last {CLOUD_AGENT_BACKFILL_DAYS} days appear in your inbox.
        </p>
      )}
      <p className="text-[11px] text-sol-text-dim">
        Agents only reach repos Cursor's GitHub app can see. Connect it under{" "}
        <a href={CLOUD_AGENT_PROVIDERS.cursor.repoAccessUrl} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-sol-text">
          Cursor → Integrations
        </a>
        .
      </p>
    </CloudConnectDialog>
  );
}
