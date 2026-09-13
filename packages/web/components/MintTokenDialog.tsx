"use client";

// Minting a `claude setup-token` for one saved Claude account, as a guided
// act. The token is a fixed one-year credential that sessions pinned to the
// account launch with instead of the saved login. Anthropic issues it only
// through a browser sign-in, so the dialog explains what the token is for,
// tells the person which account the browser must be signed into, starts the
// daemon's flow, and follows it live through the device's cc_mint_flow.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { MINT_FLOW_STALE_MS, profileHasSetupToken } from "@codecast/convex/convex/ccAccountsShared";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export type MintFlow = {
  status: "pending" | "confirmed" | "rejected";
  profile?: string;
  email?: string;
  reason?: string;
  url?: string;
  started_at: number;
  finished_at?: number;
};

type MintDevice = {
  device_id: string;
  label?: string;
  online?: boolean;
  is_remote?: boolean;
  mint_flow?: MintFlow | null;
};

type MintProfile = {
  name: string;
  email?: string;
  login_expired_at?: number | null;
  setup_token?: { stored_at: number; expires_at: number };
};

const DAY_MS = 86_400_000;

function expiryDate(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "token · 340d" on a row whose sessions launch with a minted token; red
 *  once the year is up (Claude Code never warns, so this badge has to). */
export function SetupTokenBadge({ profile, now }: { profile: MintProfile; now: number }) {
  const tok = profile.setup_token;
  if (!tok) return null;
  if (tok.expires_at <= now) {
    return (
      <span
        className="shrink-0 rounded bg-sol-red/10 px-1.5 py-0.5 text-[10px] text-sol-red"
        title="The minted token for this account is past its one-year lifetime. Mint a new one, or remove it to fall back to the saved login."
      >
        token expired
      </span>
    );
  }
  const days = Math.max(1, Math.ceil((tok.expires_at - now) / DAY_MS));
  return (
    <span
      className="shrink-0 rounded bg-sol-violet/10 px-1.5 py-0.5 text-[10px] text-sol-violet"
      title={`Sessions on this account launch with a minted token that expires ${expiryDate(tok.expires_at)}`}
    >
      token · {days}d
    </span>
  );
}

/** The row affordance: opens the guided dialog. Shown for every saved account
 *  on an online primary machine; the label says whether a token is on file. */
export function MintTokenButton({ device, profile, className }: { device: MintDevice; profile: MintProfile; className?: string }) {
  const [open, setOpen] = useState(false);
  const now = useCoarseNow(30_000);
  if (device.is_remote || device.online === false) return null;
  const flow = device.mint_flow?.profile === profile.name ? device.mint_flow : null;
  const pending = flow?.status === "pending" && now - flow.started_at < MINT_FLOW_STALE_MS;
  const has = profileHasSetupToken(profile, now);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          pending
            ? "A token is being minted for this account. Open to follow the sign-in."
            : has
              ? "A minted token is on file for this account. Open to renew or remove it."
              : "Mint a fixed one-year token for this account, with a guided browser sign-in"
        }
        className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
          pending
            ? "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
            : "border-sol-border text-sol-text-dim hover:border-sol-violet/40 hover:bg-sol-violet/10 hover:text-sol-violet"
        } ${className ?? ""}`}
      >
        {pending ? (
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" aria-hidden />
        ) : (
          <KeyRound className="h-3 w-3" aria-hidden />
        )}
        {pending ? "minting…" : has ? "token" : "mint token"}
      </button>
      {open && <MintTokenDialog device={device} profile={profile} onClose={() => setOpen(false)} />}
    </>
  );
}

function Step({ n, state, children }: { n: number; state: "todo" | "active" | "done"; children: React.ReactNode }) {
  const ring =
    state === "done"
      ? "border-sol-green bg-sol-green/15 text-sol-green"
      : state === "active"
        ? "border-amber-500 bg-amber-500/15 text-amber-500"
        : "border-sol-border text-sol-text-dim";
  return (
    <li className="flex items-start gap-2.5">
      <span className={`mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${ring}`}>
        {state === "done" ? "✓" : n}
      </span>
      <span className={`text-xs leading-relaxed ${state === "todo" ? "text-sol-text-dim" : "text-sol-text"}`}>{children}</span>
    </li>
  );
}

export function MintTokenDialog({ device, profile, onClose }: { device: MintDevice; profile: MintProfile; onClose: () => void }) {
  const requestMint = useMutation(api.accountSwitch.requestMintToken);
  const removeToken = useMutation(api.accountSwitch.removeSetupToken);
  const [busy, setBusy] = useState<"start" | "remove" | null>(null);
  // Set the moment Start is pressed in THIS dialog: the server's pending
  // stamp arrives a moment later, and an earlier confirmed/rejected outcome
  // for the same profile must not show as this attempt's result meanwhile.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const now = useCoarseNow(5_000);
  const who = profile.email ?? profile.name;

  const flow = device.mint_flow?.profile === profile.name ? device.mint_flow : null;
  const fresh = !!flow && (startedAt === null || flow.started_at >= startedAt - 15_000);
  const pending = busy === "start" || (fresh && flow?.status === "pending" && now - flow.started_at < MINT_FLOW_STALE_MS);
  const rejected = fresh && flow?.status === "rejected" && !!flow.finished_at && now - flow.finished_at < 30 * 60 * 1000;
  const confirmed = fresh && flow?.status === "confirmed" && !!flow.finished_at && now - flow.finished_at < 30 * 60 * 1000;
  const url = pending ? flow?.url : undefined;
  const has = profileHasSetupToken(profile, now);
  const expired = !!profile.setup_token && !has;

  const start = async (force: boolean) => {
    setBusy("start");
    try {
      const res = await requestMint({ device_id: device.device_id, profile: profile.name, ...(force ? { force: true } : {}) });
      setStartedAt(Date.now());
      if (res?.already_pending) toast.message("A mint is already waiting for the browser sign-in");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the mint");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await removeToken({ device_id: device.device_id, profile: profile.name });
      toast.success(`Token removed for ${who}. Sessions fall back to the saved login.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the token");
    } finally {
      setBusy(null);
    }
  };

  const step1: "todo" | "active" | "done" = confirmed || pending ? "done" : "todo";
  const step2: "todo" | "active" | "done" = confirmed ? "done" : pending ? "active" : "todo";
  const step3: "todo" | "active" | "done" = confirmed ? "done" : "todo";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg bg-sol-card border-sol-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sol-text">
            <KeyRound className="h-4 w-4 text-sol-violet" />
            Mint a token for {who}
          </DialogTitle>
          <DialogDescription className="text-sol-text-muted">
            A fixed one year sign in for this account, kept in a private file on {device.label ?? "this machine"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs leading-relaxed text-sol-text-muted">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sol-text-dim">Why a token</div>
            <p>
              Sessions pinned to <span className="text-sol-text">{profile.name}</span> normally run on its saved login,
              which renews itself. A renewal can still fail: two processes refreshing the same grant, a keychain reset,
              or an older Claude Code that ignores per account logins. A token never changes, so none of that can
              strand it. It also works when the saved login has expired
              {profile.login_expired_at ? <span className="text-amber-500"> (it has, for this account)</span> : null}.
            </p>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sol-text-dim">Why the browser</div>
            <p>
              Anthropic issues a token only through a sign in on claude.ai. Codecast never sees your password. The
              browser page must be signed in as <span className="text-sol-text">{who}</span>. If it is signed into
              another Claude account, sign out there first or use a private window, then press Authorize.
            </p>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sol-text-dim">The trade</div>
            <p>
              The token expires after one year and Claude Code gives no warning. The account row shows the days left
              so you can mint again before then. Revoke a token any time at claude.ai under Settings, Claude Code.
            </p>
          </div>

          <ol className="space-y-2 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
            <Step n={1} state={step1}>
              Codecast runs <code className="rounded bg-sol-bg px-1 py-px font-mono text-[11px]">claude setup-token</code> on {device.label ?? "this machine"}.
            </Step>
            <Step n={2} state={step2}>
              Your browser opens the claude.ai sign in. Sign in as <span className="text-sol-text">{who}</span> and press Authorize.
              {pending && (
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-amber-500">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" aria-hidden />
                    waiting for your approval in the browser
                  </span>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-amber-400">
                      open the sign in page again
                    </a>
                  ) : (
                    <span className="text-sol-text-dim">opening the page…</span>
                  )}
                  <button
                    type="button"
                    onClick={() => start(true)}
                    disabled={busy !== null}
                    className="underline decoration-dotted underline-offset-2 hover:text-amber-400"
                    title="Kill the running mint and start a fresh one"
                  >
                    start over
                  </button>
                </span>
              )}
            </Step>
            <Step n={3} state={step3}>
              Codecast checks the token belongs to {who} and stores it here. The check compares the account&apos;s rate
              limit windows; a token for a different account is refused.
            </Step>
          </ol>

          {rejected && (
            <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">
              The mint did not complete: {flow?.reason ?? "unknown reason"}.
            </p>
          )}
          {confirmed && (
            <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
              Token stored for {flow?.email ?? who}
              {profile.setup_token ? `, expires ${expiryDate(profile.setup_token.expires_at)}` : ""}. New sessions pinned to
              this account launch with it.
              {flow?.reason ? <span className="mt-1 block text-amber-500">Note: {flow.reason}.</span> : null}
            </p>
          )}
          {!pending && !confirmed && (has || expired) && (
            <p className="text-[11px] text-sol-text-dim">
              {expired
                ? "The token on file is past its year. Minting again replaces it."
                : `A token is on file, expires ${expiryDate(profile.setup_token!.expires_at)}. Minting again replaces it.`}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {(has || expired) && !pending && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={remove} className="h-7 px-2 text-[11px] text-sol-red hover:bg-sol-red/10 hover:text-sol-red">
                {busy === "remove" ? "Removing…" : "Remove token"}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} className="h-7 px-2 text-[11px]">
              {confirmed ? "Done" : "Close"}
            </Button>
            {!pending && !confirmed && (
              <Button size="sm" disabled={busy !== null} onClick={() => start(false)} className="h-7 px-3 text-[11px]">
                {rejected ? "Try again" : has || expired ? "Mint a new token" : "Start, open the sign in"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
