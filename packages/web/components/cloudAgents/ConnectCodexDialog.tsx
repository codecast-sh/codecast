"use client";

// Guided sign-in for Codex Cloud. Codex Cloud runs on the person's ChatGPT
// plan and has no API keys: codecast reads the tasks with the machine's own
// `codex login`. So the dialog asks that machine where its sign-in stands
// (its daemon checks with Codex and answers with the account and plan, never
// the token), and when there is none, or it expired, has the daemon run
// `codex login` there, which opens Codex's sign-in page in that machine's
// browser, then checks until it lands. Codecast never refreshes the login:
// a refresh would sign out the Codex the person runs themselves.

import { RefreshCw } from "lucide-react";
import { CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { useCloudAgentLogin } from "../../lib/useProviderKeyCommand";
import { Spinner, Step } from "../MintTokenDialog";
import { Button } from "../ui/button";
import { CopyCommand } from "../conversation/blocks/shared";
import { CloudConnectDialog } from "./CloudConnectDialog";
import { usePinnedCloudAgentMachine } from "./machine";
import { useCloudAgentConnected } from "./credentials";
import { CloudAgentConnectedSync, CloudAgentRepoAccessLink } from "./parts";

const CODEX = CLOUD_AGENT_PROVIDERS.codex;

export function ConnectCodexDialog({ onClose, deviceId }: { onClose: () => void; deviceId?: string | null }) {
  const { device, machine } = usePinnedCloudAgentMachine(deviceId, useCloudAgentConnected(CODEX));
  const { view, waiting, timedOut, signIn, recheck, prompt } = useCloudAgentLogin(CODEX.id, device);
  const signedIn = view.state === "signed_in";
  const needsSignIn = view.state === "signed_out" || view.state === "expired";
  // A machine with no browser (a cloud host) signs in with a code, from a terminal there.
  const headless = !!device?.is_remote;
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
      outdated={oldDaemon}
      done={signedIn}
      onClose={onClose}
    >
      {view.state === "checking" && <Spinner label={`checking the Codex sign-in on ${machine}`} />}

      {signedIn && (
        <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
          {machine} is signed in to Codex{view.account ? ` as ${view.account}` : ""}{view.plan ? ` (${view.plan} plan)` : ""}.
        </p>
      )}
      {signedIn && <CloudAgentConnectedSync spec={CODEX} onNavigate={onClose} />}

      {(needsSignIn || waiting) && !signedIn && headless && (
        <div className="space-y-2 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
          <p>
            {view.state === "expired" ? <>The Codex sign-in on {machine} has expired.</> : <>{machine} has no Codex sign-in.</>}{" "}
            It has no browser, so it signs in with a code you enter here.
          </p>
          {prompt ? <DeviceCodeSteps prompt={prompt} /> : (
            <Button type="button" size="sm" onClick={() => void signIn({ deviceCode: true })} disabled={waiting} className="h-7 px-2.5 text-[11px]">
              {waiting ? "Getting a code…" : "Sign in with a code"}
            </Button>
          )}
          {waiting && <Spinner label="waiting for the sign-in" />}
          <p className="text-[11px] text-sol-text-dim">Or in a terminal there: <CopyCommand command={CODEX.login.headlessArgv.join(" ")} /></p>
        </div>
      )}
      {(needsSignIn || waiting) && !signedIn && !headless && (
        <ol className="space-y-3 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
          <Step n={1} state={step1}>
            {view.state === "expired"
              ? <>The Codex sign-in on {machine}{view.account ? ` (${view.account})` : ""} has expired. Codecast never refreshes it, because that would sign out the Codex you run yourself.</>
              : <>{machine} has no Codex sign-in.{"detail" in view && view.detail ? ` ${view.detail}` : ""}</>}
            <span className="mt-1.5 block">
              <Button type="button" size="sm" onClick={() => void signIn()} disabled={waiting} className="h-7 px-2.5 text-[11px]">
                {waiting ? "Signing in…" : "Sign in to Codex"}
              </Button>
            </span>
          </Step>
          <Step n={2} state={step2}>
            Codex opens its sign-in page in the browser on {machine}. Sign in with the ChatGPT account your Codex Cloud tasks run on.
            {waiting && <Spinner label="waiting for the sign-in" />}
            {prompt ? <DeviceCodeSteps prompt={prompt} /> : !waiting && (
              <button type="button" onClick={() => void signIn({ deviceCode: true })} className="mt-1 block text-[11px] text-sol-text-dim underline underline-offset-2 hover:text-sol-text">
                Not at {machine}? Sign in here with a code
              </button>
            )}
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
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-500">{view.error}</p>
      )}

      {view.state !== "checking" && !waiting && (
        <button type="button" onClick={() => void recheck()} className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text">
          <RefreshCw className="h-3 w-3" aria-hidden /> Check again
        </button>
      )}
      <p className="text-[11px] text-sol-text-dim">
        Tasks run in the repository's Codex environment. Set one up under <CloudAgentRepoAccessLink spec={CODEX} className="hover:text-sol-text" />.
      </p>
    </CloudConnectDialog>
  );
}

/** The page and one-time code a device-code sign-in finishes with, on any device. */
function DeviceCodeSteps({ prompt }: { prompt: { url: string; code: string } }) {
  return (
    <span className="mt-1.5 block space-y-1">
      <a href={prompt.url} target="_blank" rel="noreferrer" className="block underline underline-offset-2">Open {prompt.url.replace(/^https:\/\//, "")}</a>
      <span className="block">and enter <span className="select-all rounded bg-sol-bg px-1.5 py-0.5 font-mono text-[12px] font-bold tracking-wider text-sol-text">{prompt.code}</span></span>
    </span>
  );
}
