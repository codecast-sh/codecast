import { useSettingsData } from "../../../hooks/useSyncSettings";
"use client";

import { copyToClipboard } from "../../../lib/utils";
// First-class management of Claude Code accounts. Saved logins are
// device-local and execute daemon-side; secrets never leave the machine.
// Enrolling an account needs one /login in a terminal; from then on every
// saved login carries sessions through its own credential store. A browser
// opens again only when a person asks for it here: "sign in again" on a dead
// login, or "mint token" for a fixed one-year token (MintTokenDialog).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  exhaustionBannerCopy,
  isExhaustionCurrent,
  isValidProfileName,
  profileHasToken,
  type CcUsage,
} from "@codecast/convex/convex/ccAccountsShared";
import { AppLoader } from "../../../components/AppLoader";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Laptop, Pin, Trash2, Zap } from "lucide-react";
import {
  AccountUsageBars,
  LoginExpiredBadge,
  ProfileSignInButton,
  UsageRefreshButton,
  type ProfileLoginFlow,
} from "../../../components/AccountUsageMeter";
import { MintTokenButton, SetupTokenBadge, type MintFlow } from "../../../components/MintTokenDialog";
import { formatAgo } from "@codecast/shared/contracts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useAccountRecoveryToggles } from "../../../hooks/useAccountRecoveryToggles";
import { RecoveryModeSelect, RecoveryDecisionNote } from "../../../components/RecoveryModeSelect";
import { useMachineAccountSwitch } from "../../../hooks/useMachineAccountSwitch";
import { machineSwitchBlock, profileIsCurrentLogin } from "../../../lib/machineAccountSwitch";

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
    setup_token?: { stored_at: number; expires_at: number };
    login_expired_at?: number;
  }>;
  auto_switch: boolean;
  /** Absent on servers that predate the field — treated as on. */
  auto_continue?: boolean;
  auto_switch_state?: { last_action_at?: number; last_action?: string; exhausted_at?: number };
  login_flow?: ProfileLoginFlow | null;
  mint_flow?: MintFlow | null;
};

function sessionsBadge(
  p: { token?: { expires_at: number }; setup_token?: { expires_at: number }; login_expired_at?: number },
  now: number,
): { label: string; tone: string; title: string } | null {
  // A live minted token outranks the store at launch: its own badge says so.
  if (p.setup_token && p.setup_token.expires_at > now) return null;
  if (!p.token || p.login_expired_at) return null;
  if (p.token.expires_at <= now) {
    return {
      label: "grant lifetime over",
      tone: "bg-sol-red/10 text-sol-red",
      title: "This saved login's refresh lifetime has run out — sign into it again and sessions can use it",
    };
  }
  return {
    label: "sessions",
    tone: "bg-sol-violet/10 text-sol-violet",
    title: "This account has its own credential store on the machine; sessions can be pinned to it without changing the current login",
  };
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

function SessionAccountsStatus({ device }: { device: DeviceAccounts }) {
  const now = useCoarseNow(30_000);
  const ready = device.profiles.filter((p) => profileHasToken(p, now) && !p.login_expired_at);
  const needSignIn = device.profiles.filter((p) => !!p.login_expired_at);
  const total = device.profiles.length;

  return (
    <>
      <div className="flex items-center gap-2.5 px-4 py-3 sm:px-5">
        <Pin className="h-4 w-4 shrink-0 text-sol-violet" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text">Sessions on saved accounts</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-sol-text-dim">
            Every saved login gets its own credential store on this machine, so a session can run on
            any saved account while the current login stays put. When a blocked session switches
            accounts, codecast restarts only its Claude Code process on the new account; the
            conversation stays intact and other sessions keep running. Stores are filled and renewed
            automatically; nothing here opens a browser on its own. Prefer a fixed one-year token for
            an account? &quot;mint token&quot; on its row walks you through the browser sign-in and
            explains the trade.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-3 pl-[42px] text-[11px] text-sol-text-dim sm:px-5 sm:pl-[46px]">
        <span>
          {ready.length} of {total} saved account{total === 1 ? "" : "s"} can carry sessions.
        </span>
        {needSignIn.length > 0 && (
          <span className="text-amber-500">
            {needSignIn.length === 1
              ? `${needSignIn[0].email ?? needSignIn[0].name} needs you to sign in again.`
              : `${needSignIn.length} accounts need you to sign in again.`}
          </span>
        )}
      </div>
    </>
  );
}

function AutoSwitchToggle({ device }: { device: DeviceAccounts }) {
  const now = useCoarseNow(30_000);
  const { recovery } = useAccountRecoveryToggles(device);
  const state = device.auto_switch_state;
  // Time-aware: the stamp is only cleared by a re-check that may never run, so
  // past the session window it needs a still-pegged account to stand on.
  const exhausted = isExhaustionCurrent(state?.exhausted_at, device.profiles, now);

  return (
    <>
      <div className="flex items-start gap-2.5 px-4 py-3 sm:px-5">
        <Zap
          className={`mt-0.5 h-4 w-4 shrink-0 ${recovery.mode === "off" ? "text-sol-text-dim" : "text-sol-cyan"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text">When a session hits a usage limit</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-sol-text-dim">
            This machine runs one Claude login at a time, so changing accounts moves every session on
            it. Subagent workers are left out of a revive.
          </p>
          <div className="mt-2">
            <RecoveryModeSelect control={recovery} />
          </div>
        </div>
      </div>
      {recovery.mode === "auto" && exhausted && (
        <div className="bg-sol-red/10 px-4 py-2 text-[11px] text-sol-red sm:px-5">
          {exhaustionBannerCopy(device.profiles, now)}
        </div>
      )}
      {!exhausted && state?.last_decision && (
        <div className="px-4 py-2 sm:px-5">
          <RecoveryDecisionNote decision={state.last_decision} now={now} />
        </div>
      )}
      {!exhausted && !state?.last_decision && state?.last_action && state.last_action_at && (
        <div className="px-4 py-2 text-[11px] text-sol-text-dim sm:px-5">
          Last action: {state.last_action.replace("switch:", "switched to ")}{" "}
          {formatAgo(now - state.last_action_at)}.
        </div>
      )}
    </>
  );
}

function DeviceAccountsSection({ device }: { device: DeviceAccounts }) {
  const removeProfile = useMutation(api.accountSwitch.removeAccountProfile);
  const now = useCoarseNow(30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const sw = useMachineAccountSwitch({ deviceId: device.device_id, activeEmail: device.active_email });

  const online = device.online !== false;
  const activeProfile = device.profiles.find((p) => profileIsCurrentLogin(p, device.active_email));
  // Suggest the email's local part as the profile name (claude2@almostcandid.com -> claude2).
  const suggested = (device.active_email?.split("@")[0] ?? "work").toLowerCase();
  const rowBusy = busy ?? sw.switching;

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
          {!device.is_remote && <UsageRefreshButton device={device} />}
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
          const isActive = profileIsCurrentLogin(p, device.active_email);
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
                <LoginExpiredBadge profile={p} />
                <ProfileSignInButton
                  device={device}
                  profile={p}
                  force={
                    sw.outcome?.kind === "error" &&
                    sw.outcome.profile === p.name &&
                    /sign in again/i.test(sw.outcome.message)
                  }
                />
                <SetupTokenBadge profile={p} now={now} />
                <MintTokenButton device={device} profile={p} />
                {(() => {
                  const badge = sessionsBadge(p, now);
                  return badge ? (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.tone}`} title={badge.title}>
                      {badge.label}
                    </span>
                  ) : null;
                })()}
                {sw.switching === p.name ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-sol-cyan">
                    <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-sol-cyan/30 border-t-sol-cyan" aria-hidden />
                    Switching…
                    <button
                      type="button"
                      onClick={sw.cancel}
                      className="text-[11px] font-medium text-current/80 underline-offset-2 hover:underline"
                    >
                      cancel
                    </button>
                  </span>
                ) : isActive ? (
                  <span className="shrink-0 text-[11px] font-medium text-sol-green">active</span>
                ) : confirmRemove === p.name ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[11px] text-sol-text-dim">Forget this saved login?</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={rowBusy !== null}
                      onClick={() => handleRemove(p.name)}
                      className="h-6 px-2 text-[11px]"
                    >
                      {busy === p.name ? "Removing…" : "Remove"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rowBusy !== null}
                      onClick={() => setConfirmRemove(null)}
                      className="h-6 px-2 text-[11px]"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <>
                    {(() => {
                      const blocked = machineSwitchBlock({
                        isActive: false,
                        online,
                        isRemote: device.is_remote,
                        loginExpired: !!p.login_expired_at,
                        thisProfile: p.name,
                      });
                      if (blocked?.block === "login_expired") return null;
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!blocked}
                          onClick={() => void sw.switchTo(p.name, p.email)}
                          title={
                            blocked?.label ??
                            `Switch this machine to "${p.name}". Running sessions keep the account they started on.`
                          }
                          className="h-6 px-2 text-[11px]"
                        >
                          Switch
                        </Button>
                      );
                    })()}
                    <button
                      onClick={() => setConfirmRemove(p.name)}
                      disabled={rowBusy !== null || !online}
                      aria-label="Remove this profile from the machine"
                      title="Remove this profile from the machine"
                      className="shrink-0 rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-red/10 hover:text-sol-red"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              {sw.outcome?.kind === "error" && sw.outcome.profile === p.name && (
                <div className="mt-1.5 pl-[18px] text-[11px] text-sol-red">{sw.outcome.message}</div>
              )}
              {sw.outcome?.kind === "success" && sw.outcome.profile === p.name && (
                <div className="mt-1.5 pl-[18px] text-[11px] text-sol-green">
                  Now using {p.name}. Running sessions keep the account they started on.
                </div>
              )}
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
      {!device.is_remote && <SessionAccountsStatus device={device} />}

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
  const { data } = useSettingsData("accountProfiles");

  return (
    <SettingsPanel>
      <p className="px-1 text-sm text-sol-text-muted leading-relaxed">
        Each Claude account you log into is saved as a profile automatically. New sessions run on the
        current account, while running sessions keep the account they started with. Switching
        changes the default without interrupting them. When sessions are parked on a usage limit,
        "switch &amp; continue" restarts only those Claude Code processes on the selected account
        and resumes the same conversations.
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
          Profiles are stored in the machine's keychain; tokens never leave it. Saved logins are renewed
          automatically. If one stops working, its row shows &quot;sign in again&quot;: that opens the
          browser once, for that account only, and the current login stays as it is. A minted token
          (&quot;mint token&quot; on the row) is the fixed alternative: it needs no renewal and works even
          when the saved login has expired, at the cost of a yearly re-mint in the browser.
        </p>
      </SettingsSection>
    </SettingsPanel>
  );
}
