"use client";

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
import { isValidProfileName } from "@codecast/convex/convex/ccAccountsShared";
import { Card } from "../../../components/ui/card";
import { AppLoader } from "../../../components/AppLoader";
import { Button } from "../../../components/ui/button";
import { toast } from "sonner";
import { Check, Copy, KeyRound } from "lucide-react";

type DeviceAccounts = {
  device_id: string;
  label: string;
  is_remote: boolean;
  active_email?: string;
  profiles: Array<{ name: string; email?: string; tier?: string; subscription?: string }>;
};

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
        navigator.clipboard.writeText(cmd).then(() => {
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
    <div className="mt-3 rounded-md border border-sol-yellow/40 bg-sol-yellow/[0.06] p-3">
      <div className="text-xs font-medium text-sol-text">
        New login: <span className="text-sol-yellow">{device.active_email}</span> isn't saved as a profile yet
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-sol-text-dim">
        The daemon saves new logins automatically within ~30 seconds. Save it now to pick the
        name yourself — either way you'll be able to switch back to it later.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="profile name"
          className="h-7 w-36 rounded border border-sol-border bg-sol-bg px-2 text-xs text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
        />
        <Button size="sm" variant="outline" disabled={busy || !name} onClick={handleSave} className="h-7 text-xs">
          {busy ? "Saving…" : "Save as profile"}
        </Button>
      </div>
    </div>
  );
}

function DeviceAccountsCard({ device }: { device: DeviceAccounts }) {
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const [busy, setBusy] = useState<string | null>(null);

  const activeProfile = device.profiles.find((p) => p.email && p.email === device.active_email);
  // Suggest the email's org part as the profile name (ashot@footage.com -> footage).
  const suggested = (device.active_email?.split("@")[1]?.split(".")[0] ?? "work").toLowerCase();

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

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm truncate">{device.label}</span>
        {device.is_remote && (
          <span className="px-1.5 py-0.5 rounded text-[10px] border bg-sol-violet/10 text-sol-violet border-sol-violet/30">
            remote — mirrors the primary's account
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim">
          <span className="h-1.5 w-1.5 rounded-full bg-sol-green" />
          online
        </span>
      </div>

      <div className="mt-3 space-y-1.5">
        {device.profiles.map((p) => {
          const isActive = !!p.email && p.email === device.active_email;
          const plan = planLabel(p);
          return (
            <div
              key={p.name}
              className={`flex items-center gap-2.5 rounded-md border px-3 py-2 ${
                isActive ? "border-sol-green/30 bg-sol-green/[0.05]" : "border-sol-border/50"
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-sol-green" : "bg-sol-border"}`} />
              <span className="text-sm font-medium text-sol-text">{p.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-sol-text-muted">{p.email}</span>
              {plan && (
                <span className="shrink-0 rounded border border-sol-cyan/30 bg-sol-cyan/10 px-1.5 py-0.5 text-[10px] text-sol-cyan">
                  {plan}
                </span>
              )}
              {isActive ? (
                <span className="shrink-0 text-[11px] font-medium text-sol-green">active</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || device.is_remote}
                  onClick={() => handleSwitch(p.name)}
                  className="h-6 px-2 text-[11px]"
                >
                  {busy === p.name ? "Switching…" : "Switch"}
                </Button>
              )}
            </div>
          );
        })}
        {device.profiles.length === 0 && (
          <div className="rounded-md border border-dashed border-sol-border/60 px-3 py-2 text-xs text-sol-text-dim">
            No saved profiles on this machine yet.
          </div>
        )}
      </div>

      {!device.is_remote && device.active_email && !activeProfile && (
        <SaveCurrentForm device={device} suggestedName={suggested} />
      )}
      {!device.is_remote && activeProfile && (
        <div className="mt-2 text-[11px] text-sol-text-dim">
          Currently logged in as <span className="text-sol-text">{device.active_email}</span> (saved as "{activeProfile.name}").
        </div>
      )}
    </Card>
  );
}

export default function ClaudeAccountsSettings() {
  const data = useQuery(api.accountSwitch.listAccountProfiles, {});

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-sol-text flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-sol-cyan" />
          Claude Accounts
        </h2>
        <p className="mt-1 text-sm text-sol-text-muted leading-relaxed">
          Every Claude Code session on a machine shares one login. Each account you log into gets saved
          as a profile automatically, so you can switch the whole machine instantly — no browser, no
          re-login. Switching never interrupts
          running sessions: they keep their account until restarted, while new and resumed sessions use
          the new one. When sessions are parked on a usage limit, the inbox banner offers
          "switch &amp; continue" to revive them on the other account.
        </p>
      </div>

      {data === undefined && (
        <AppLoader className="min-h-0 bg-transparent py-12" size={28} />
      )}

      {data && data.devices.length === 0 && (
        <Card className="p-4">
          <div className="text-sm font-medium text-sol-text">No daemon is reporting accounts yet</div>
          <p className="mt-1 text-xs text-sol-text-muted leading-relaxed">
            Account profiles are reported by the codecast daemon on each machine. Make sure the daemon is
            running and up to date (<CopyableCommand cmd="cast restart" />), then save your current login:
          </p>
          <div className="mt-2"><CopyableCommand cmd="cast accounts save <name>" /></div>
        </Card>
      )}

      {data?.devices.map((d) => (
        <DeviceAccountsCard key={d.device_id} device={d} />
      ))}

      <Card className="p-4">
        <div className="text-sm font-medium text-sol-text">Add another account</div>
        <ol className="mt-2 space-y-2 text-xs text-sol-text-muted leading-relaxed list-decimal list-inside">
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
      </Card>
    </div>
  );
}
