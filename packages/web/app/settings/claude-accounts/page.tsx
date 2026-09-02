"use client";

import { copyToClipboard } from "../../../lib/utils";
// First-class management of Claude Code accounts (the Max/Pro login every
// claude session on a machine shares). The credential is machine-global, so
// everything here is per-device and executes daemon-side: profiles are
// keychain snapshots the daemon reports on its heartbeat (names/emails/tiers
// only — tokens never leave the machine). Enrolling an account needs ONE
// /login in a terminal, ever; after it's saved here, switching is instant and
// browser-free. See convex/accountSwitch.ts + cli/src/ccAccounts.ts.

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  exhaustionBannerCopy,
  isExhaustionCurrent,
  isValidProfileName,
  profileHasToken,
  MINT_FLOW_STALE_MS,
  type CcUsage,
} from "@codecast/convex/convex/ccAccountsShared";
import { AppLoader } from "../../../components/AppLoader";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Laptop, Pin, TimerReset, Trash2, Zap } from "lucide-react";
import { AccountUsageBars } from "../../../components/AccountUsageMeter";
import { formatAgo } from "@codecast/shared/contracts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useAccountRecoveryToggles } from "../../../hooks/useAccountRecoveryToggles";

type DeviceAccounts = {
  device_id: string;
  label: string;
  is_remote: boolean;
  /** Absent on servers that predate the field — those only return online devices. */
  online?: boolean;
  active_email?: string;
  profiles: Array<{
    name: string;
    email?: string;
    tier?: string;
    subscription?: string;
    usage?: CcUsage;
    token?: { stored_at: number; expires_at: number };
  }>;
  auto_switch: boolean;
  /** Absent on servers that predate the field — treated as on. */
  auto_continue?: boolean;
  auto_switch_state?: { last_action_at?: number; last_action?: string; exhausted_at?: number };
  /** Per-session accounts (setup-tokens). Absent on older servers — off. */
  session_tokens?: boolean;
  mint_flow?: {
    status: "pending" | "confirmed" | "rejected";
    profile?: string;
    email?: string;
    reason?: string;
    started_at: number;
    finished_at?: number;
  };
};

function tokenBadge(p: { token?: { expires_at: number } }, now: number): { label: string; tone: string } | null {
  if (!p.token) return null;
  if (p.token.expires_at <= now) return { label: "token expired", tone: "bg-sol-red/10 text-sol-red" };
  const days = Math.max(1, Math.ceil((p.token.expires_at - now) / 86_400_000));
  return { label: `token · ${days}d`, tone: "bg-sol-violet/10 text-sol-violet" };
}

function planLabel(p: { tier?: string; subscription?: string }): string | null {
  if (!p.subscription) return null;
  const base = p.subscription.charAt(0).toUpperCase() + p.subscription.slice(1);
  if (p.tier?.includes("20x")) return `${base} 20x`;
  if (p.tier?.includes("5x")) return `${base} 5x`;
  return base;
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        copyToClipboard(cmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded bg-sol-bg-alt px-2 py-1 font-mono text-[11px] text-sol-text hover:bg-sol-bg-alt/70 transition-colors"
      title="Copy command"
    >
      {cmd}
      {copied ? <Check className="h-3 w-3 text-sol-green" /> : <Copy className="h-3 w-3 text-sol-text-dim" />}
    </button>
  );
}

function SaveCurrentForm({ device, suggestedName }: { device: DeviceAccounts; suggestedName: string }) {
  const saveProfile = useMutation(api.accountSwitch.saveAccountProfile);
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!isValidProfileName(name)) {
      toast.error("Profile names: letters/digits/dot/dash/underscore");
      return;
    }
    setBusy(true);
    try {
      await saveProfile({ name, device_id: device.device_id });
      toast.success(`Saving "${name}" — it appears below in a few seconds`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  // Prominent: an unsaved login is the one state that needs the user's
  // attention here. Normally transient — the daemon auto-saves new logins on
  // its next heartbeat — so when this persists, the manual save IS the path.
  return (
    <div className="bg-sol-yellow/[0.06] px-4 py-3 sm:px-5">
      <div className="text-xs font-medium text-sol-text">
        New login: <span className="text-sol-yellow">{device.active_email}</span> isn't saved as a profile yet
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-sol-text-dim">
        The daemon saves new logins automatically within ~30 seconds. Save it now to pick the
        name yourself — either way you'll be able to switch back to it later.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="profile name"
          className="h-7 w-36 text-xs bg-sol-bg border-sol-border text-sol-text placeholder:text-sol-text-dim"
        />
        <Button size="sm" variant="outline" disabled={busy || !name} onClick={handleSave} className="h-7 text-xs">
          {busy ? "Saving…" : "Save as profile"}
        </Button>
      </div>
    </div>
  );
}

// Per-session accounts: the machine-global keychain login is the DEFAULT; with
// this on, each new session is pinned to a saved profile's one-year
// `claude setup-token` instead, so switching the machine's login (by hand or
// auto-switch on a limit) never moves a running session, and a revived
// session is pinned to the account it was moved to. Tokens are minted by the
// daemon — one browser approval per account — and renewed a week before
// they expire.
function SessionTokensToggle({ device }: { device: DeviceAccounts }) {
  const now = useCoarseNow(30_000);
  const { sessionTokens } = useAccountRecoveryToggles(device);
  const requestMint = useMutation(api.accountSwitch.requestMintToken);
  const [minting, setMinting] = useState(false);
  const online = device.online !== false;
  const activeProfile = device.profiles.find((p) => p.email && p.email === device.active_email);
  const activeHasToken = !!activeProfile && profileHasToken(activeProfile, now);
  const flow = device.mint_flow;
  const pending = flow?.status === "pending" && now - flow.started_at < MINT_FLOW_STALE_MS;
  const rejected = flow?.status === "rejected";
  const withTokens = device.profiles.filter((p) => profileHasToken(p, now)).length;

  const mint = async (force: boolean) => {
    setMinting(true);
    try {
      const res = await requestMint({ device_id: device.device_id, force });
      toast.success(
        res?.already_pending
          ? "A mint is already waiting for the browser approval"
          : `Minting a token for ${res?.email ?? "the current login"} — approve the sign-in in the browser`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mint failed");
    } finally {
      setMinting(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5 px-4 py-3 sm:px-5">
        <Pin className={`h-4 w-4 shrink-0 ${sessionTokens.on ? "text-sol-violet" : "text-sol-text-dim"}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text">Pin each session to its own account</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-sol-text-dim">
            By default every session on this machine shares one login, so switching accounts moves
            all of them. With this on, codecast mints a one-year Claude Code token for each saved
            account (one browser approval per account) and launches every new session on the
            current account&apos;s token. Sessions then keep their account across switches and
            restarts, and a session revived on another account is pinned there. Identity and
            usage meters still come from the saved login. Tokens live in a private file on this
            machine and are renewed a week before they expire.
          </p>
        </div>
        <Switch
          checked={sessionTokens.on}
          onCheckedChange={sessionTokens.set}
          disabled={sessionTokens.pending}
          aria-label="Pin each session to its own account"
        />
      </div>
      {sessionTokens.on && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-[42px] text-[11px] text-sol-text-dim sm:px-5 sm:pl-[46px]">
          {pending ? (
            <span className="text-sol-yellow">
              Minting for {flow?.email ?? flow?.profile ?? "the current login"}… approve the Claude sign-in in your browser.
            </span>
          ) : rejected && !activeHasToken ? (
            <span className="text-sol-red">Mint failed: {flow?.reason ?? "unknown reason"}</span>
          ) : activeHasToken ? (
            <span>
              {withTokens} of {device.profiles.length} saved account{device.profiles.length === 1 ? "" : "s"} have a
              token. To add one for another account, switch to it and it mints on its own.
            </span>
          ) : (
            <span>The current login has no token yet.</span>
          )}
          {online && !pending && (
            <Button
              size="sm"
              variant="outline"
              disabled={minting}
              onClick={() => mint(rejected)}
              className="h-6 px-2 text-[11px]"
            >
              {minting ? "Starting…" : rejected && !activeHasToken ? "Try again" : activeHasToken ? "Re-mint" : "Mint now"}
            </Button>
          )}
          {pending && online && (
            <button
              onClick={() => mint(true)}
              disabled={minting}
              className="text-sol-text-dim underline decoration-dotted underline-offset-2 hover:text-sol-text"
            >
              browser didn&apos;t open? relaunch
            </button>
          )}
        </div>
      )}
    </>
  );
}

function AutoSwitchToggle({ device }: { device: DeviceAccounts }) {
  const now = useCoarseNow(30_000);
  const { autoSwitch, autoContinue } = useAccountRecoveryToggles(device);
  const enabled = autoSwitch.on;
  const state = device.auto_switch_state;
  // Time-aware: the stamp is only cleared by a re-check that may never run, so
  // past the session window it needs a still-pegged account to stand on.
  const exhausted = isExhaustionCurrent(state?.exhausted_at, device.profiles, now);

  return (
    <>
      <div className="flex items-center gap-2.5 px-4 py-3 sm:px-5">
        <Zap className={`h-4 w-4 shrink-0 ${enabled ? "text-sol-cyan" : "text-sol-text-dim"}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text">Auto-switch accounts on usage limits</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-sol-text-dim">
            When sessions park on a usage limit, switch this machine to the saved account with the
            most headroom and continue them — retrying through accounts (and window resets) until
            everything is unblocked or every account is spent. Subagent workers are left out.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={autoSwitch.set}
          disabled={autoSwitch.pending}
          aria-label="Auto-switch accounts on usage limits"
        />
      </div>
      <div className="flex items-center gap-2.5 px-4 py-3 sm:px-5">
        <TimerReset
          className={`h-4 w-4 shrink-0 ${autoContinue.on ? "text-sol-cyan" : "text-sol-text-dim"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text">Resume at window reset</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-sol-text-dim">
            Sessions parked on this account&apos;s limit in the last few hours get a &quot;continue&quot;
            on their own once the window resets — no account change. Off means they stay parked
            until you continue them.
          </p>
        </div>
        <Switch
          checked={autoContinue.on}
          onCheckedChange={autoContinue.set}
          disabled={autoContinue.pending}
          aria-label="Resume at window reset"
        />
      </div>
      {enabled && exhausted && (
        <div className="bg-sol-red/10 px-4 py-2 text-[11px] text-sol-red sm:px-5">
          {exhaustionBannerCopy(device.profiles, now)}
        </div>
      )}
      {(enabled || autoContinue.on) && !exhausted && state?.last_action && state.last_action_at && (
        <div className="px-4 py-2 text-[11px] text-sol-text-dim sm:px-5">
          Last action: {state.last_action.replace("switch:", "switched to ")}{" "}
          {formatAgo(now - state.last_action_at)}.
        </div>
      )}
    </>
  );
}

function DeviceAccountsSection({ device }: { device: DeviceAccounts }) {
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const removeProfile = useMutation(api.accountSwitch.removeAccountProfile);
  const now = useCoarseNow(30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const online = device.online !== false;
  const activeProfile = device.profiles.find((p) => p.email && p.email === device.active_email);
  // Suggest the email's local part as the profile name (claude2@almostcandid.com -> claude2).
  const suggested = (device.active_email?.split("@")[0] ?? "work").toLowerCase();

  const handleSwitch = async (profile: string) => {
    setBusy(profile);
    try {
      // Pure swap: running sessions are untouched; new/resumed ones adopt the
      // account. Reviving blocked sessions stays with the inbox banner / CLI.
      await requestSwitch({ profile, device_id: device.device_id, continue_blocked: false });
      toast.success(`Switching to "${profile}" — new and resumed sessions will use it`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Switch failed");
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (profile: string) => {
    setBusy(profile);
    try {
      // The mutation eagerly drops the row from the device's reported
      // inventory (instant here); the daemon deletes the keychain snapshot
      // behind it, and its next heartbeat confirms — or resurrects the row
      // if the deletion failed.
      await removeProfile({ name: profile, device_id: device.device_id });
      toast.success(`Removed "${profile}" — log into that account again anytime to re-add it`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(null);
      setConfirmRemove(null);
    }
  };

  return (
    <SettingsSection
      title={device.label}
      icon={Laptop}
      actions={
        <>
          {device.is_remote && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-sol-violet/10 text-sol-violet">
              remote — mirrors the primary's account
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim">
            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-sol-green" : "bg-sol-border"}`} />
            {online ? "online" : "offline"}
          </span>
        </>
      }
    >
      {!online && (
        <p className="px-4 py-2.5 text-[11px] leading-relaxed text-sol-text-dim sm:px-5">
          The daemon on this machine isn't reporting right now (<CopyableCommand cmd="cast restart" /> brings
          it back). Account switching needs it; the auto-switch setting below still saves.
        </p>
      )}

      {device.profiles.map((p) => {
          const isActive = !!p.email && p.email === device.active_email;
          const plan = planLabel(p);
          return (
            <div
              key={p.name}
              className={`px-4 py-2.5 sm:px-5 ${isActive ? "bg-sol-green/[0.05]" : ""}`}
            >
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-sol-green" : "bg-sol-border"}`} />
                <span className="text-sm font-medium text-sol-text">{p.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-sol-text-muted">{p.email}</span>
                {plan && (
                  <span className="shrink-0 rounded bg-sol-cyan/10 px-1.5 py-0.5 text-[10px] text-sol-cyan">
                    {plan}
                  </span>
                )}
                {(() => {
                  const badge = tokenBadge(p, now);
                  return badge ? (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.tone}`}
                      title="A one-year setup-token is stored for this account; sessions can be pinned to it"
                    >
                      {badge.label}
                    </span>
                  ) : null;
                })()}
                {isActive ? (
                  <span className="shrink-0 text-[11px] font-medium text-sol-green">active</span>
                ) : confirmRemove === p.name ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[11px] text-sol-text-dim">Forget this saved login?</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy !== null}
                      onClick={() => handleRemove(p.name)}
                      className="h-6 px-2 text-[11px]"
                    >
                      {busy === p.name ? "Removing…" : "Remove"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setConfirmRemove(null)}
                      className="h-6 px-2 text-[11px]"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || device.is_remote || !online}
                      onClick={() => handleSwitch(p.name)}
                      className="h-6 px-2 text-[11px]"
                    >
                      {busy === p.name ? "Switching…" : "Switch"}
                    </Button>
                    <button
                      onClick={() => setConfirmRemove(p.name)}
                      disabled={busy !== null || !online}
                      aria-label="Remove this profile from the machine"
                      title="Remove this profile from the machine"
                      className="shrink-0 rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-red/10 hover:text-sol-red"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              <div className="mt-2 pl-[18px]">
                <AccountUsageBars usage={p.usage} now={now} />
              </div>
            </div>
          );
        })}
      {device.profiles.length === 0 && (
        <div className="px-4 py-3 text-xs text-sol-text-dim sm:px-5">
          No saved profiles on this machine yet.
        </div>
      )}

      {!device.is_remote && <AutoSwitchToggle device={device} />}
      {!device.is_remote && <SessionTokensToggle device={device} />}

      {!device.is_remote && online && device.active_email && !activeProfile && (
        <SaveCurrentForm device={device} suggestedName={suggested} />
      )}
      {!device.is_remote && activeProfile && (
        <div className="px-4 py-2 text-[11px] text-sol-text-dim sm:px-5">
          Currently logged in as <span className="text-sol-text">{device.active_email}</span> (saved as "{activeProfile.name}").
        </div>
      )}
    </SettingsSection>
  );
}

export default function ClaudeAccountsSettings() {
  const data = useQuery(api.accountSwitch.listAccountProfiles, {});

  return (
    <SettingsPanel>
      <p className="px-1 text-sm text-sol-text-muted leading-relaxed">
        Every Claude Code session on a machine shares one login. Each account you log into gets saved
        as a profile automatically, so you can switch the whole machine instantly — no browser, no
        re-login. Switching never interrupts
        running sessions: they keep their account until restarted, while new and resumed sessions use
        the new one. When sessions are parked on a usage limit, the inbox banner offers
        "switch &amp; continue" to revive them on the other account.
      </p>

      {data === undefined && (
        <AppLoader className="min-h-0 bg-transparent py-12" size={28} />
      )}

      {data && data.devices.length === 0 && (
        <SettingsSection title="Devices" icon={Laptop} padded>
          <div className="text-sm font-medium text-sol-text">No daemon is reporting accounts yet</div>
          <p className="mt-1 text-xs text-sol-text-muted leading-relaxed">
            Account profiles are reported by the codecast daemon on each machine. Make sure the daemon is
            running and up to date (<CopyableCommand cmd="cast restart" />), then save your current login:
          </p>
          <div className="mt-2"><CopyableCommand cmd="cast accounts save <name>" /></div>
        </SettingsSection>
      )}

      {data?.devices.map((d) => (
        <DeviceAccountsSection key={d.device_id} device={d} />
      ))}

      <SettingsSection title="Add another account" icon={KeyRound} padded>
        <ol className="space-y-2 text-xs text-sol-text-muted leading-relaxed list-decimal list-inside">
          <li>
            In any terminal on that machine, run <CopyableCommand cmd="claude /login" /> and pick the other
            account — this is the only time the browser is involved, ever.
          </li>
          <li>
            That's it — the daemon saves the new login as a profile automatically and it appears here
            within ~30 seconds. To pick the profile name yourself, run{" "}
            <CopyableCommand cmd="cast accounts save <name>" /> instead.
          </li>
          <li>
            Switch between saved accounts from here, the inbox banner, or{" "}
            <CopyableCommand cmd="cast accounts use <name>" /> any time.
          </li>
        </ol>
        <p className="mt-2 text-[11px] text-sol-text-dim">
          Profiles are stored in the machine's keychain; tokens never leave it. The outgoing account is
          re-snapshotted automatically on every switch, so saved profiles never go stale.
        </p>
      </SettingsSection>
    </SettingsPanel>
  );
}
