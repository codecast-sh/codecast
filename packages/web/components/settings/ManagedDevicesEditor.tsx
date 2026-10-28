"use client";
/**
 * Settings > Managed devices: an IT admin makes the team's Macs managed. The
 * page runs in the order of the job: set up (the installer, then an
 * enrollment token with its configuration profile, then the push from the
 * MDM), the devices that enrolled, and the policy they carry (the shared
 * catalog, @codecast/shared/contracts managedPolicy, the same keys the server
 * guards and the heartbeat carries). Admins only (convex/managedDevices.ts).
 *
 * Policy writes, revokes and restores are store actions that paint at once.
 * Minting a token and building its profile call their mutations directly
 * instead: the answer is a secret shown once, which must not ride the dispatch
 * outbox into IndexedDB.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Check, Download, Laptop, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { MANAGED_POLICY, parseTeamPolicy, type TeamPolicy } from "@codecast/shared/contracts";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsLinkRow, SettingsPanel, SettingsRow, SettingsSection } from "./ui";
import { useInboxStore } from "../../store/inboxStore";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useCopy } from "../../hooks/useCopy";
import { relativeTime } from "../../lib/entityDisplay";
import { ConfirmButton } from "../integrations/parts";
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

type TokenRow = { _id: string; name: string; prefix: string; created_at: number; revoked_at: number | null; last_used_at: number | null; devices: number };
type DeviceRow = { _id: string; hostname: string | null; platform: string | null; email: string | null; person_name: string | null; status: "pending" | "active" | "revoked"; enrolled_at: number | null; created_at: number; last_seen?: number | null };
type Overview = { tokens: TokenRow[]; devices: DeviceRow[] };

/** The admin overview of a team's managed devices, from the settings cache. */
function useManagedDevicesOverview(teamId: string | null | undefined): Overview | undefined {
  return useSettingsData("managedDevices", teamId ? String(teamId) : undefined).data as Overview | undefined;
}

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

export function ManagedDevicesPanel({ teamId, teamName }: { teamId: Id<"teams">; teamName: string }) {
  const team = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId)));
  const policy: TeamPolicy = parseTeamPolicy(team?.policy);
  const overview = useManagedDevicesOverview(String(teamId));
  const [mdm, setMdm] = useState<MdmVendorId>(DEFAULT_MDM_VENDOR);
  const setPolicy = (next: TeamPolicy) => useInboxStore.getState().setTeamPolicy(String(teamId), parseTeamPolicy(next) as Record<string, unknown>);
  const restrictionsOn = RESTRICTIONS.filter((d) => (policy as any)[d.key] === true).length;
  const devices = overview?.devices ?? [];
  const enrolled = devices.filter((d) => d.status === "active").length;
  const liveTokens = (overview?.tokens ?? []).filter((t) => !t.revoked_at).length;
  const vendor = MDM_VENDORS.find((m) => m.id === mdm) ?? MDM_VENDORS[0];

  return (
    <SettingsPanel>
      <SettingsSection title="Set up" icon={ShieldCheck}>
        <Step n={1} done={enrolled > 0} label="Installer" value="Codecast.pkg">
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2">
            <a href={MDM_PKG_URL} data-mdm-pkg>
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </Button>
        </Step>
        <Step n={2} done={liveTokens > 0} label="Configuration profile" value={liveTokens ? `${liveTokens} active ${liveTokens === 1 ? "token" : "tokens"}` : undefined}>
          <select
            value={mdm}
            onChange={(e) => setMdm(e.target.value as MdmVendorId)}
            className="h-7 rounded-md border border-sol-border bg-transparent px-1.5 text-xs text-sol-text"
            aria-label="Your MDM"
            data-mdm-vendor
          >
            {MDM_VENDORS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <NewToken teamId={teamId} teamName={teamName} restrictionsOn={restrictionsOn} mdm={mdm} />
        </Step>
        <Tokens teamId={teamId} tokens={overview?.tokens} />
        <Step n={3} done={enrolled > 0} label={`Push both from ${vendor.name}`} value={enrolled ? `${enrolled} ${enrolled === 1 ? "Mac" : "Macs"} enrolled` : "No Mac yet"} />
      </SettingsSection>

      <SettingsSection title="Devices" icon={Laptop} actions={<span className="tabular-nums text-xs text-sol-text-dim">{enrolled}</span>}>
        <Devices teamId={teamId} devices={overview ? devices : undefined} />
      </SettingsSection>

      <SettingsSection title="Policy" icon={SlidersHorizontal}>
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
      </SettingsSection>
    </SettingsPanel>
  );
}

/** One setup step: its number (a check once done), its name, its state and its control. */
function Step({ n, done, label, value, children }: { n: number; done: boolean; label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-5" data-mdm-step={n} data-done={done || undefined}>
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
          done ? "border-sol-green/40 bg-sol-green/10 text-sol-green" : "border-sol-border text-sol-text-muted"
        }`}
      >
        {done ? <Check className="h-3 w-3" strokeWidth={2.5} /> : n}
      </span>
      <span className="text-sm text-sol-text">{label}</span>
      {value && <span className="text-xs text-sol-text-dim">{value}</span>}
      <span className="flex-1" />
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
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
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Folder path" className="h-7 font-mono text-xs" aria-label="Folder to never sync" />
          <Button type="submit" variant="ghost" size="sm" className="h-7 px-2" disabled={!draft.trim()}>Add</Button>
        </form>
      </div>
    </SettingsRow>
  );
}

/** Mint a token, then hand its profile over at once: the token is shown this one time. */
function NewToken({ teamId, teamName, restrictionsOn, mdm }: { teamId: Id<"teams">; teamName: string; restrictionsOn: number; mdm: MdmVendorId }) {
  const createToken = useMutation(api.managedDevices.createEnrollmentToken);
  const buildProfile = useMutation(api.managedDevices.buildEnrollmentProfile);
  const { state, copy } = useCopy();
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
  const download = async (token: string) => {
    try {
      const { filename, mobileconfig } = await buildProfile({ team_id: teamId, token, mdm });
      const url = URL.createObjectURL(new Blob([mobileconfig], { type: "application/x-apple-aspen-config" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build the profile");
    }
  };
  if (minted) {
    return (
      <div className="flex items-center gap-1.5" data-mdm-minted>
        <Button variant="cyan" size="sm" className="h-7 gap-1 px-2" onClick={() => download(minted.token)} data-mdm-profile>
          <Download className="h-3.5 w-3.5" /> Profile
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copy(() => minted.token)} title={minted.token}>
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy token"}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-sol-text-dim" onClick={() => setMinted(null)} aria-label="Hide token">Done</Button>
      </div>
    );
  }
  return (
    <>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name" className="h-7 w-32 text-xs" aria-label="Token name" />
      <ConsequentialSwitch
        on={false}
        ledger={tokenLedger(teamName, restrictionsOn)}
        onTurnOn={create}
        onTurnOff={() => {}}
        trigger={({ press, reviewing }) => (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={press} aria-haspopup="dialog" aria-expanded={reviewing} data-mdm-new-token>
            Create
          </Button>
        )}
      />
    </>
  );
}

function Tokens({ teamId, tokens }: { teamId: Id<"teams">; tokens?: TokenRow[] }) {
  if (!tokens?.length) return null;
  return (
    <div className="px-4 pb-2 pl-12 sm:px-5 sm:pl-[3.25rem]" data-mdm-tokens>
      {tokens.map((t) => (
        <div key={t._id} className={`flex items-center gap-3 py-1 text-xs ${t.revoked_at ? "opacity-50" : ""}`}>
          <span className="w-32 truncate text-sol-text">{t.name}</span>
          <span className="w-28 font-mono text-sol-text-dim">{t.prefix}…</span>
          <span className="w-20 tabular-nums text-sol-text-muted">{t.devices} {t.devices === 1 ? "Mac" : "Macs"}</span>
          <span className="flex-1 text-sol-text-dim">{relativeTime(t.created_at)}</span>
          {t.revoked_at ? (
            <span className="text-sol-text-dim">Revoked</span>
          ) : (
            <ConfirmButton
              label="Revoke"
              question="No new Mac can enroll with it. Enrolled Macs stay."
              className="text-sol-text-dim hover:text-sol-red hover:no-underline"
              onConfirm={() => useInboxStore.getState().revokeEnrollmentToken(String(teamId), t._id)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

const STATUS = {
  active: { label: "Enrolled", cls: "text-sol-green" },
  pending: { label: "Waiting for sign-in", cls: "text-sol-yellow" },
  revoked: { label: "Removed", cls: "text-sol-text-dim" },
} as const;

function Devices({ teamId, devices }: { teamId: Id<"teams">; devices?: DeviceRow[] }) {
  if (devices && devices.length === 0) {
    return <div className="px-4 py-3 text-xs text-sol-text-dim sm:px-5">None yet</div>;
  }
  return (
    <div className="px-4 py-1.5 sm:px-5" data-mdm-devices>
      {(devices ?? []).map((d) => (
        <div key={d._id} className="flex items-center gap-3 py-1.5 text-xs" data-mdm-device={d.status}>
          <Laptop className={`h-3.5 w-3.5 shrink-0 ${d.status === "revoked" ? "text-sol-text-dim/50" : "text-sol-text-dim"}`} />
          <span className={`w-36 truncate ${d.status === "revoked" ? "text-sol-text-dim" : "text-sol-text"}`} title={d.hostname ?? undefined}>{d.hostname ?? "Unnamed Mac"}</span>
          <span className="w-44 truncate text-sol-text-muted" title={d.email ?? undefined}>{d.person_name ?? d.email ?? "—"}</span>
          <span className={`w-32 ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
          <span className="flex-1 text-sol-text-dim">
            {d.status === "active" && d.last_seen ? `seen ${relativeTime(d.last_seen)}` : relativeTime(d.enrolled_at ?? d.created_at)}
          </span>
          {d.status === "revoked" ? (
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => useInboxStore.getState().restoreDeviceEnrollment(String(teamId), d._id)}>
              Allow again
            </Button>
          ) : (
            <ConfirmButton
              label="Remove"
              question="Signs this Mac out and takes it off the team's policy."
              className="text-sol-text-dim hover:text-sol-red hover:no-underline"
              onConfirm={() => useInboxStore.getState().revokeDeviceEnrollment(String(teamId), d._id)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Team settings' way in: what the team's managed fleet is, one row that opens the page. */
export function ManagedDevicesLink({ teamId }: { teamId: string }) {
  const team = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === teamId));
  const overview = useManagedDevicesOverview(teamId);
  const enrolled = (overview?.devices ?? []).filter((d) => d.status === "active").length;
  const policy = parseTeamPolicy(team?.policy);
  const restrictions = RESTRICTIONS.filter((d) => (policy as any)[d.key] === true).length;
  const value = [
    `${enrolled} ${enrolled === 1 ? "Mac" : "Macs"}`,
    ...(restrictions ? [`${restrictions} ${restrictions === 1 ? "restriction" : "restrictions"}`] : []),
  ].join(" · ");
  return (
    <SettingsSection>
      <SettingsLinkRow icon={ShieldCheck} label="Managed devices" value={value} onClick={() => useInboxStore.getState().openSettingsModal("managed-devices")} />
    </SettingsSection>
  );
}
