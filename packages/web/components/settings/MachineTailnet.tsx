"use client";

import { Check } from "lucide-react";
import { peerLinkState, tailnetShortName, type PeerLinkState } from "@codecast/shared/contracts/peerTransport";
import { useInboxStore } from "../../store/inboxStore";
import { localDeviceIdOf } from "../../hooks/useLocalDeviceId";
import { cmpVersions } from "../../lib/desktopFloor";
import { deviceDisplayName, type Device } from "../DeviceBadge";
import { Switch } from "../ui/switch";
import { SettingsBadge } from "./ui";

const INSTALL_URL = "https://tailscale.com/download";
const SWITCH_ACCOUNT_URL = "https://tailscale.com/kb/1225/fast-user-switching";
const USERSPACE_URL = "https://tailscale.com/kb/1112/userspace-networking";
// The first CLI whose heartbeat reports its tailnet; an older one never says, so its silence means nothing.
const TAILNET_REPORT_SINCE = "1.1.221";

type Why = Extract<PeerLinkState, { state: "relayed" }>["why"];

const WHY_LABEL: Record<Why, string> = {
  self_off: "No Tailscale here",
  peer_off: "No Tailscale there",
  different_tailnet: "Other tailnet",
  other_account: "Other account",
  not_bindable: "Userspace mode",
  peer_offline: "Offline",
  disabled: "Links off",
  last_failed: "Last try failed",
};

const linkClass = "text-meta text-sol-cyan underline underline-offset-2";

function Action({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className={linkClass}>{children}</a>;
}

function Press({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={linkClass}>{children}</button>;
}

function reportsTailnet(d: Device): boolean {
  return !!d.cli_version && cmpVersions(d.cli_version, TAILNET_REPORT_SINCE) >= 0;
}

// The peer's own chip already names these causes; the pair chip then says only "Relay".
const SHOWN_ON_MACHINE: ReadonlySet<Why> = new Set(["peer_off", "not_bindable"]);

function pairLabel(why: Why, self: Device): string {
  if (SHOWN_ON_MACHINE.has(why)) return "Relay";
  if (why === "self_off" && !reportsTailnet(self)) return "Relay · Tailscale unknown here";
  return `Relay · ${WHY_LABEL[why]}`;
}

/** "connect_timeout: no answer in 5s" -> "no answer in 5s". */
function readableReason(reason: string): string {
  return reason.replace(/^[a-z_]+:\s*/, "");
}

function UpdateCli({ d }: { d: Device }) {
  return <Press onClick={() => useInboxStore.getState().openSettingsModal("daemon")}>Update CLI on {deviceDisplayName(d)}</Press>;
}

function fixFor(why: Why, peer: Device, self: Device, setDirectLinks: (id: string, on: boolean) => void) {
  switch (why) {
    case "self_off":
    case "peer_off": {
      const d = why === "self_off" ? self : peer;
      return reportsTailnet(d) ? <Action href={INSTALL_URL}>Install Tailscale on {deviceDisplayName(d)}</Action> : <UpdateCli d={d} />;
    }
    case "other_account":
      return <Action href={SWITCH_ACCOUNT_URL}>Switch account</Action>;
    case "different_tailnet":
      return (
        <>
          <span className="text-meta text-sol-text-muted" data-tailnets>
            {deviceDisplayName(self)} {self.tailnet?.tailnet} · {deviceDisplayName(peer)} {peer.tailnet?.tailnet}
          </span>
          <Action href={SWITCH_ACCOUNT_URL}>Switch tailnet</Action>
        </>
      );
    case "not_bindable":
      return <Action href={USERSPACE_URL}>Fix on {deviceDisplayName(peer)}</Action>;
    case "disabled": {
      const off = [peer, self].filter((d) => d.direct_links_off);
      const label = off.length === 2 ? "Turn on both" : off[0] === self ? "Turn on here" : "Turn on";
      return <Press onClick={() => off.forEach((d) => setDirectLinks(d.device_id, true))}>{label}</Press>;
    }
    default:
      return null;
  }
}

function selfSig(s: Parameters<typeof localDeviceIdOf>[0] & { machineRoster: unknown[] }): string {
  const id = localDeviceIdOf(s);
  const row = id ? (s.machineRoster as Device[]).find((d) => d.device_id === id) : undefined;
  return row ? JSON.stringify([row.device_id, row.label, row.tailnet, row.direct_links_off, row.cli_version]) : "";
}

export function MachineTailnet({ device, self: selfProp }: { device: Device; self?: Device | null }) {
  const sig = useInboxStore((s) => (selfProp === undefined ? selfSig(s) : ""));
  const storeSelf = sig ? ((useInboxStore.getState().machineRoster as Device[]).find((d) => d.device_id === JSON.parse(sig)[0]) ?? null) : null;
  const self = selfProp === undefined ? storeSelf : selfProp;
  const setDirectLinks = useInboxStore((s) => s.setDeviceDirectLinks);
  const isSelf = self?.device_id === device.device_id;
  const accepts = !device.direct_links_off;

  const pair = self && !isSelf
    ? peerLinkState({
        self: self.tailnet,
        peer: device.tailnet,
        peerOnline: device.online,
        directLinks: accepts && !self.direct_links_off,
        last: device.peer_links?.find((l) => l.to_device_id === self.device_id),
      })
    : null;
  const known = !!device.tailnet || reportsTailnet(device);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-machine-tailnet={device.device_id}>
      {device.tailnet ? (
        <SettingsBadge tone="cyan" title={device.tailnet.tailnet ?? undefined}>Tailscale · {tailnetShortName(device.tailnet.name)}</SettingsBadge>
      ) : (
        <SettingsBadge tone="muted">{known ? "No Tailscale" : "Tailscale unknown"}</SettingsBadge>
      )}
      {device.tailnet?.bindable === false && <SettingsBadge tone="yellow">Userspace mode</SettingsBadge>}
      {!device.tailnet && isSelf && (known ? <Action href={INSTALL_URL}>Install Tailscale</Action> : <UpdateCli d={device} />)}
      {pair?.state === "direct" && (
        <SettingsBadge tone="green" data-pair="direct" title={pair.proven ? "Proven" : "Untested"}>
          {pair.proven ? <Check className="mr-1 h-3 w-3" aria-label="Proven" /> : <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current" aria-label="Untested" />}
          Direct
        </SettingsBadge>
      )}
      {pair?.state === "relayed" && (
        <>
          <SettingsBadge tone="neutral" data-pair="relay" tabIndex={pair.reason ? 0 : undefined} title={pair.reason}>{pairLabel(pair.why, self!)}</SettingsBadge>
          {pair.reason && <span className="max-w-[16rem] truncate text-meta text-sol-text-muted" title={pair.reason} data-reason>{readableReason(pair.reason)}</span>}
          {fixFor(pair.why, device, self!, setDirectLinks)}
        </>
      )}
      <label className="ml-auto flex items-center gap-2 text-meta text-sol-text-muted">
        Accept direct links
        <Switch checked={accepts} onCheckedChange={(on) => setDirectLinks(device.device_id, on)} aria-label={`Accept direct links on ${deviceDisplayName(device)}`} />
      </label>
    </div>
  );
}
