"use client";
/**
 * Team settings > Managed devices: an IT admin makes the team's Macs managed.
 * The policy switches (the shared catalog, @codecast/shared/contracts
 * managedPolicy, the same keys the server guards and the heartbeat carries),
 * enrollment tokens with their configuration profile, the installer, and the
 * devices that enrolled. Admins only (convex/managedDevices.ts).
 *
 * Policy writes and revokes are store actions that paint at once. Minting a
 * token and building its profile call their mutations directly instead: the
 * answer is a secret shown once, which must not ride the dispatch outbox into
 * IndexedDB.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Download, Laptop, Plus, ShieldCheck } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { MANAGED_POLICY, parseTeamPolicy, type TeamPolicy } from "@codecast/shared/contracts";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./ui";
import { useInboxStore } from "../../store/inboxStore";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useCopy } from "../../hooks/useCopy";
import { relativeTime } from "../../lib/entityDisplay";
import { ConsequentialSwitch, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { DEFAULT_MDM_VENDOR, MDM_VENDORS, type MdmVendorId } from "@codecast/convex/convex/lib/mdmVendors";

const MDM_PKG_URL = "https://dl.codecast.sh/desktop/mdm/Codecast.pkg";

const RESTRICTIONS = MANAGED_POLICY.filter((d) => d.team && d.kind === "restriction");
const AUTO_UPDATE = MANAGED_POLICY.find((d) => d.key === "auto_update")!;
const EXCLUDED = MANAGED_POLICY.find((d) => d.key === "excluded_paths")!;
const AUTO_UPDATE_OPTIONS: Array<{ value: "on" | "off" | undefined; label: string }> = [
  { value: undefined, label: "Person decides" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

function tokenLedger(team: string, restrictions: number): SwitchLedger {
  return {
    name: "New enrollment token",
    subject: team,
    shift: null,
    figures: [
      { value: "Any", label: "Mac with its profile joins", tone: "warn" },
      { value: String(restrictions), label: restrictions === 1 ? "restriction on" : "restrictions on" },
    ],
    rows: [
      { k: "Joins as", v: `Member of ${team}`, tone: "warn" },
      { k: "Seats", v: "One per new person" },
      { k: "Sign-in", v: "The person the profile names" },
      { k: "Token shown", v: "Once" },
    ],
    stop: "Revoke the token",
    confirm: "Create token",
    keep: "Not now",
  };
}

export function ManagedDevicesEditor({ teamId, teamName }: { teamId: Id<"teams">; teamName: string }) {
  const team = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId)));
  const policy: TeamPolicy = parseTeamPolicy(team?.policy);
  const overview = useSettingsData("managedDevices", String(teamId)).data;
  const setPolicy = (next: TeamPolicy) => useInboxStore.getState().setTeamPolicy(String(teamId), parseTeamPolicy(next) as Record<string, unknown>);
  const restrictionsOn = RESTRICTIONS.filter((d) => (policy as any)[d.key] === true).length;

  return (
    <SettingsSection
      title="Managed devices"
      icon={ShieldCheck}
      actions={
        <a href={MDM_PKG_URL} className="inline-flex items-center gap-1.5 text-xs text-sol-text-muted hover:text-sol-text" data-mdm-pkg>
          <Download className="h-3.5 w-3.5" />
          Codecast.pkg
        </a>
      }
    >
      {RESTRICTIONS.map((d) => (
        <SettingsRow key={d.key} label={d.name}>
          <Switch
            checked={(policy as any)[d.key] === true}
            onCheckedChange={(on) => setPolicy({ ...policy, [d.key]: on || undefined })}
            aria-label={d.name}
          />
        </SettingsRow>
      ))}
      <SettingsRow label={AUTO_UPDATE.name}>
        <div className="flex rounded-md border border-sol-border p-0.5" role="radiogroup" aria-label={AUTO_UPDATE.name}>
          {AUTO_UPDATE_OPTIONS.map((o) => (
            <button
              key={o.label}
              role="radio"
              aria-checked={policy.auto_update === o.value}
              onClick={() => setPolicy({ ...policy, auto_update: o.value })}
              className={`rounded px-2 py-0.5 text-xs ${policy.auto_update === o.value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </SettingsRow>
      <ExcludedPaths paths={policy.excluded_paths ?? []} onChange={(paths) => setPolicy({ ...policy, excluded_paths: paths.length ? paths : undefined })} />
      <Tokens teamId={teamId} teamName={teamName} restrictionsOn={restrictionsOn} tokens={overview?.tokens} />
      <Devices teamId={teamId} devices={overview?.devices} />
    </SettingsSection>
  );
}

function ExcludedPaths({ paths, onChange }: { paths: string[]; onChange: (paths: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const p = draft.trim();
    if (p && !paths.includes(p)) onChange([...paths, p]);
    setDraft("");
  };
  return (
    <SettingsRow label={EXCLUDED.name} alignTop>
      <div className="flex w-72 flex-col items-end gap-1.5">
        {paths.map((p) => (
          <span key={p} className="inline-flex items-center gap-2 font-mono text-xs text-sol-text">
            {p}
            <button onClick={() => onChange(paths.filter((x) => x !== p))} className="text-sol-text-dim hover:text-sol-red" aria-label={`Remove ${p}`}>×</button>
          </span>
        ))}
        <form className="flex w-full gap-1.5" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="~/clients" className="h-7 font-mono text-xs" aria-label="Folder to never sync" />
          <Button type="submit" variant="ghost" size="sm" className="h-7 px-2" disabled={!draft.trim()}>Add</Button>
        </form>
      </div>
    </SettingsRow>
  );
}

type TokenRow = { _id: string; name: string; prefix: string; created_at: number; revoked_at: number | null; last_used_at: number | null; devices: number };
type DeviceRow = { _id: string; hostname: string | null; platform: string | null; email: string | null; person_name: string | null; status: "pending" | "active" | "revoked"; enrolled_at: number | null; created_at: number };

function Tokens({ teamId, teamName, restrictionsOn, tokens }: { teamId: Id<"teams">; teamName: string; restrictionsOn: number; tokens?: TokenRow[] }) {
  const createToken = useMutation(api.managedDevices.createEnrollmentToken);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(null);
  const create = async () => {
    try {
      const res = await createToken({ team_id: teamId, name: name.trim() || "Enrollment token" });
      setMinted({ token: res.token, name: res.name });
      setName("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the token");
    }
  };
  return (
    <div className="px-4 py-3" data-mdm-tokens>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm text-sol-text">Enrollment tokens</span>
        <div className="flex items-center gap-1.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name" className="h-7 w-36 text-xs" aria-label="Token name" />
          <ConsequentialSwitch
            on={false}
            ledger={tokenLedger(teamName, restrictionsOn)}
            onTurnOn={create}
            onTurnOff={() => {}}
            trigger={({ press, reviewing }) => (
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={press} aria-haspopup="dialog" aria-expanded={reviewing} data-mdm-new-token>
                <Plus className="h-3.5 w-3.5" /> New
              </Button>
            )}
          />
        </div>
      </div>
      {minted && <MintedToken teamId={teamId} minted={minted} onDone={() => setMinted(null)} />}
      {(tokens ?? []).map((t) => (
        <div key={t._id} className={`flex items-center gap-3 border-t border-sol-border/40 py-1.5 text-xs ${t.revoked_at ? "opacity-50" : ""}`}>
          <span className="w-32 truncate text-sol-text">{t.name}</span>
          <span className="w-28 font-mono text-sol-text-dim">{t.prefix}…</span>
          <span className="w-20 tabular-nums text-sol-text-muted">{t.devices} {t.devices === 1 ? "device" : "devices"}</span>
          <span className="flex-1 text-sol-text-dim">{relativeTime(t.created_at)}</span>
          {t.revoked_at ? (
            <span className="text-sol-text-dim">Revoked</span>
          ) : (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-sol-red hover:bg-sol-red/10" onClick={() => useInboxStore.getState().revokeEnrollmentToken(String(teamId), t._id)}>
              Revoke
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function MintedToken({ teamId, minted, onDone }: { teamId: Id<"teams">; minted: { token: string; name: string }; onDone: () => void }) {
  const buildProfile = useMutation(api.managedDevices.buildEnrollmentProfile);
  const { state, copy } = useCopy();
  const [mdm, setMdm] = useState<MdmVendorId>(DEFAULT_MDM_VENDOR);
  const download = async () => {
    try {
      const { filename, mobileconfig } = await buildProfile({ team_id: teamId, token: minted.token, mdm });
      const url = URL.createObjectURL(new Blob([mobileconfig], { type: "application/x-apple-aspen-config" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build the profile");
    }
  };
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md bg-sol-yellow/10 px-3 py-2" data-mdm-minted>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-sol-text" title={minted.token}>{minted.token}</code>
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copy(() => minted.token)}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </Button>
      <select
        value={mdm}
        onChange={(e) => setMdm(e.target.value as MdmVendorId)}
        className="h-7 rounded-md border border-sol-border bg-transparent px-1.5 text-xs text-sol-text"
        aria-label="Your MDM"
        data-mdm-vendor
      >
        {MDM_VENDORS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={download} data-mdm-profile>
        <Download className="h-3.5 w-3.5" /> Profile
      </Button>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-sol-text-dim" onClick={onDone} aria-label="Hide token">Done</Button>
    </div>
  );
}

const STATUS = {
  active: { label: "Active", cls: "text-sol-green" },
  pending: { label: "Waiting for sign-in", cls: "text-sol-yellow" },
  revoked: { label: "Revoked", cls: "text-sol-text-dim" },
} as const;

function Devices({ teamId, devices }: { teamId: Id<"teams">; devices?: DeviceRow[] }) {
  return (
    <div className="border-t border-sol-border/40 px-4 py-3" data-mdm-devices>
      <div className="mb-2 flex items-center gap-2 text-sm text-sol-text">
        Devices
        <span className="tabular-nums text-xs text-sol-text-dim">{(devices ?? []).filter((d) => d.status === "active").length}</span>
      </div>
      {(devices ?? []).map((d) => (
        <div key={d._id} className={`flex items-center gap-3 border-t border-sol-border/40 py-1.5 text-xs ${d.status === "revoked" ? "opacity-50" : ""}`}>
          <Laptop className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
          <span className="w-36 truncate text-sol-text" title={d.hostname ?? undefined}>{d.hostname ?? "Unnamed Mac"}</span>
          <span className="w-44 truncate text-sol-text-muted" title={d.email ?? undefined}>{d.person_name ?? d.email ?? "—"}</span>
          <span className={`w-32 ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
          <span className="flex-1 text-sol-text-dim">{relativeTime(d.enrolled_at ?? d.created_at)}</span>
          {d.status !== "revoked" && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-sol-red hover:bg-sol-red/10" onClick={() => useInboxStore.getState().revokeDeviceEnrollment(String(teamId), d._id)}>
              Revoke
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
