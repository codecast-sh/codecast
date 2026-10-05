"use client";

// Signing a saved Claude account in again, as a guided act. The daemon runs
// `claude auth login` for that profile into the profile's own credential
// store, so the machine's current login is untouched, and reports through the
// device's cc_login_flow (scoped by profile name). The sign-in happens in a
// browser, often in another tab or on another machine, so the dialog lives at
// window level (a store slot, not inside the hover panel that launched it)
// and stays up through the whole flow: waiting, relaunch, the code-paste
// path, and the outcome.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { LOGIN_FLOW_STALE_MS } from "@codecast/convex/convex/ccAccountsShared";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useSettingsData } from "../hooks/useSyncSettings";
import { useMountEffect } from "../hooks/useMountEffect";
import { useInboxStore } from "../store/inboxStore";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Spinner, Step } from "./MintTokenDialog";
import { LoginCodePaste } from "./LoginCodePaste";

export type ProfileLoginFlow = {
  status: "pending" | "confirmed" | "rejected";
  email?: string;
  profile?: string;
  reason?: string;
  url?: string;
  started_at: number;
  finished_at?: number;
};

export type SignInDevice = {
  device_id: string;
  label?: string;
  online?: boolean;
  is_remote?: boolean;
  login_flow?: ProfileLoginFlow | null;
  profiles?: Array<{ name: string; email?: string; login_expired_at?: number | null }>;
};

export type ProfileFlowPhase = "pending" | "confirmed" | "rejected" | "stalled";

// An outcome older than this belongs to an earlier attempt, not this one.
const OUTCOME_FRESH_MS = 10 * 60 * 1000;

/** Where one profile's sign-in stands on a machine, or null when the
 *  machine's flow belongs to another profile (or there is none, or its
 *  outcome is old). A pending flow past LOGIN_FLOW_STALE_MS means the daemon
 *  died mid-flow. */
export function profileFlowPhase(
  device: Pick<SignInDevice, "login_flow">,
  profileName: string,
  now: number,
): ProfileFlowPhase | null {
  const flow = device.login_flow;
  if (!flow || flow.profile !== profileName) return null;
  if (flow.status === "pending") return now - flow.started_at < LOGIN_FLOW_STALE_MS ? "pending" : "stalled";
  if (!flow.finished_at || now - flow.finished_at > OUTCOME_FRESH_MS) return null;
  return flow.status;
}

/** Window-level host: renders the dialog the store slot names. */
export function ProfileSignInDialogHost() {
  const target = useInboxStore((s) => s.profileSignIn);
  if (!target) return null;
  return <ProfileSignInDialog key={`${target.deviceId}:${target.profile}`} {...target} />;
}

function ProfileSignInDialog({ deviceId, profile: profileName, start: startOnOpen }: { deviceId: string; profile: string; start?: boolean }) {
  const close = useInboxStore((s) => s.closeProfileSignIn);
  const { data } = useSettingsData("accountProfiles");
  const device = (data?.devices as SignInDevice[] | undefined)?.find((d) => d.device_id === deviceId);
  const profile = device?.profiles?.find((p) => p.name === profileName) ?? { name: profileName };
  const requestLogin = useMutation(api.accountSwitch.requestLoginFlow);
  const now = useCoarseNow(5_000);
  const [busy, setBusy] = useState(false);
  const [blockedBy, setBlockedBy] = useState<string | null>(null);
  // The machine's flow when Start was pressed here. Until the server's new
  // pending stamp replaces it, that older flow's outcome is not this attempt's.
  const [replaced, setReplaced] = useState<number | null | undefined>(undefined);

  const flow = device?.login_flow ?? null;
  const superseded = replaced !== undefined && (flow?.started_at ?? null) === replaced;
  const phase = device && !superseded ? profileFlowPhase(device, profileName, now) : null;
  const pending = busy || superseded || phase === "pending";
  const confirmed = phase === "confirmed";
  const failed = phase === "rejected" || phase === "stalled";
  const machine = device?.label || "the selected machine";
  const who = profile.email ?? profileName;
  const unreachable = !device || device.online === false || device.is_remote;

  const start = async (force: boolean) => {
    if (!device) return;
    setBlockedBy(null);
    setReplaced(flow?.started_at ?? null);
    setBusy(true);
    try {
      const res = await requestLogin({ device_id: device.device_id, profile: profileName, ...(force ? { force: true } : {}) });
      // The machine runs one sign-in at a time; another profile's may hold it.
      if (res && "already_pending" in res) {
        setReplaced(undefined);
        if (flow?.profile !== profileName) setBlockedBy(res.email ?? "another account");
      }
    } catch (err) {
      setReplaced(undefined);
      toast.error(err instanceof Error ? err.message : "Couldn't start the sign-in");
    } finally {
      setBusy(false);
    }
  };

  // "sign in again" opens the dialog AND starts: the click already said so.
  // Reopening a running flow ("show") only watches it.
  useMountEffect(() => {
    if (startOnOpen && profileFlowPhase(device ?? {}, profileName, Date.now()) !== "pending") void start(false);
  });

  const step1 = confirmed || pending ? "done" : "active";
  const step2 = confirmed ? "done" : pending ? "active" : "todo";
  const step3 = confirmed ? "done" : "todo";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto bg-sol-card border-sol-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sol-text">
            <KeyRound className="h-4 w-4 text-amber-500" />
            Sign in to {who}
          </DialogTitle>
          <DialogDescription className="text-sol-text-muted">
            The saved login for this account stopped working. Signing in again restores it on {machine}; the
            machine&apos;s current login stays as it is.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs leading-relaxed text-sol-text-muted">
          <ol className="space-y-2 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
            <Step n={1} state={step1}>
              Codecast runs <code className="rounded bg-sol-bg px-1 py-px font-mono text-[11px]">claude auth login</code> for this account on {machine}.
            </Step>
            <Step n={2} state={step2}>
              The browser on {machine} opens claude.ai. Sign in as <span className="text-sol-text">{who}</span> and approve.
              {pending && (
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-amber-500">
                  <Spinner label={busy || superseded ? `asking ${machine} to open the page` : "waiting for the sign-in"} />
                  <button
                    type="button"
                    onClick={() => start(true)}
                    disabled={busy}
                    className="underline decoration-dotted underline-offset-2 hover:text-amber-400"
                    title={`Kill the running sign-in on ${machine} and open a fresh browser page`}
                  >
                    page didn&apos;t open? relaunch
                  </button>
                </span>
              )}
            </Step>
            <Step n={3} state={step3}>
              The login lands in this account&apos;s own store, and sessions can use it again.
            </Step>
          </ol>

          {phase === "pending" && flow?.url && device && (
            <div className="rounded-md border border-sol-border p-3">
              <p>Not at {machine}? Open the sign-in page here, then paste the code it shows.</p>
              <LoginCodePaste deviceId={device.device_id} flow={flow} defaultOpen />
            </div>
          )}
          {blockedBy && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-500">
              {machine} is finishing a sign-in for {blockedBy}. Complete it or relaunch it first, then try again.
            </p>
          )}
          {failed && (
            <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">
              The sign-in didn&apos;t complete: {phase === "stalled" ? `${machine} stopped answering` : flow?.reason ?? "unknown reason"}.
            </p>
          )}
          {confirmed && (
            <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
              Signed in as {flow?.email ?? who}. Sessions on {machine} can use this account again.
            </p>
          )}
          {unreachable && !confirmed && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-500">
              {device?.is_remote ? `${machine} has no browser to sign in with.` : `The daemon on ${machine} is offline.`}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button size="sm" variant="ghost" onClick={close} className="h-7 px-2 text-[11px]">
            {confirmed ? "Done" : "Close"}
          </Button>
          {!pending && !confirmed && !unreachable && (
            <Button size="sm" disabled={busy} onClick={() => start(failed)} className="h-7 px-3 text-[11px]">
              {failed ? "Try again" : "Start the sign-in"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
