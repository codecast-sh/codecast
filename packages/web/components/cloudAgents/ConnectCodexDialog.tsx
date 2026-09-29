"use client";

// Guided sign-in for Codex Cloud. Codex Cloud runs on the person's ChatGPT
// plan and has no API keys: codecast reads the tasks with the machine's own
// `codex login`. So the dialog asks that machine where its sign-in stands
// (its daemon checks with Codex and answers with the account and plan, never
// the token), and when there is none, or it expired, has the daemon run
// `codex login` there, which opens Codex's sign-in page in that machine's
// browser, then checks until it lands. Codecast never refreshes the login:
// a refresh would sign out the Codex the person runs themselves.

import Link from "next/link";
import { ExternalLink, RefreshCw } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS, CLOUD_SESSION_SOURCES, cloudSessionSyncOn } from "@codecast/shared/contracts";
import { useCloudAgentLogin } from "../../lib/useProviderKeyCommand";
import { useInboxStore } from "../../store/inboxStore";
import { Spinner, Step } from "../MintTokenDialog";
import { Button } from "../ui/button";
import { CloudConnectDialog, usePinnedCloudAgentMachine } from "./CloudConnectDialog";
import { useCloudAgentConnected } from "./credentials";

const CODEX = CLOUD_AGENT_PROVIDERS.codex;
const SYNC_FIELD = CLOUD_SESSION_SOURCES[CODEX.syncSource].field;

export function ConnectCodexDialog({ onClose, deviceId }: { onClose: () => void; deviceId?: string | null }) {
  const { device, machine } = usePinnedCloudAgentMachine(deviceId, useCloudAgentConnected(CODEX));
  const { view, waiting, timedOut, signIn, recheck } = useCloudAgentLogin(CODEX.id, device);
  const syncOn = useInboxStore((s) => cloudSessionSyncOn(SYNC_FIELD, (s.currentUser as Record<string, unknown> | null)?.[SYNC_FIELD] as boolean | undefined));
  const signedIn = view.state === "signed_in";
  const needsSignIn = view.state === "signed_out" || view.state === "expired";
  const oldDaemon = view.state === "failed" && /Unknown command/i.test(view.error);

  const step1 = signedIn || waiting ? "done" : needsSignIn ? "active" : "todo";
  const step2 = signedIn ? "done" : waiting ? "active" : "todo";

  return (
    <CloudConnectDialog
      title="Connect Codex"
      description={<>Codex Cloud tasks run on OpenAI's machines, on your ChatGPT plan. Codecast reads and drives them from {machine} with the Codex sign-in there.</>}
      device={device}
      machine={machine}
      needsPubkey={false}
      done={signedIn}
      onClose={onClose}
    >
      {view.state === "checking" && <Spinner label={`checking the Codex sign-in on ${machine}`} />}

      {signedIn && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          {machine} is signed in to Codex{view.account ? ` as ${view.account}` : ""}{view.plan ? ` (${view.plan} plan)` : ""}.{" "}
          {syncOn ? "Your Codex Cloud tasks from the last 30 days sync into your inbox." : null}
        </p>
      )}
      {signedIn && !syncOn && (
        <p className="text-[11px] text-sol-text-dim">
          To bring your Codex Cloud tasks into your inbox, turn on{" "}
          <Link href="/settings/sync" onClick={onClose} className="underline decoration-dotted underline-offset-2 hover:text-sol-text">
            Sync {CLOUD_SESSION_SOURCES[CODEX.syncSource].label}
          </Link>
          .
        </p>
      )}

      {(needsSignIn || waiting) && !signedIn && (
        <ol className="space-y-3 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
          <Step n={1} state={step1}>
            {view.state === "expired"
              ? <>The Codex sign-in on {machine}{view.account ? ` (${view.account})` : ""} has expired. Codecast never refreshes it, because that would sign out the Codex you run yourself.</>
              : <>{machine} has no Codex sign-in.{view.detail ? ` ${view.detail}` : ""}</>}
            <span className="mt-1.5 block">
              <Button type="button" size="sm" onClick={() => void signIn()} disabled={waiting} className="h-7 px-2.5 text-[11px]">
                {waiting ? "Signing in…" : "Sign in to Codex"}
              </Button>
            </span>
          </Step>
          <Step n={2} state={step2}>
            Codex opens its sign-in page in the browser on {machine}. Sign in with the ChatGPT account your Codex Cloud tasks run on.
            {waiting && <Spinner label="waiting for the sign-in" />}
            {timedOut && <span className="mt-1 block text-[11px] text-amber-500">The sign-in didn't finish. Try again.</span>}
          </Step>
        </ol>
      )}

      {view.state === "disabled" && (
        <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">{view.detail ?? "Codex Cloud is not enabled for this ChatGPT workspace."}</p>
      )}
      {view.state === "unreachable" && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-500">
          Couldn't reach Codex from {machine}{view.detail ? `: ${view.detail}` : ""}.
        </p>
      )}
      {view.state === "failed" && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-500">
          {oldDaemon ? `Update codecast on ${machine} to connect Codex from here.` : view.error}
        </p>
      )}

      {view.state !== "checking" && !waiting && (
        <button type="button" onClick={() => void recheck()} className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text">
          <RefreshCw className="h-3 w-3" aria-hidden /> Check again
        </button>
      )}
      <p className="text-[11px] text-sol-text-dim">
        Tasks run in the repository's Codex environment. Set one up under{" "}
        <a href={CODEX.repoAccessUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 hover:text-sol-text">
          Codex → Environments <ExternalLink className="h-2.5 w-2.5" aria-hidden />
        </a>
        .
      </p>
    </CloudConnectDialog>
  );
}
