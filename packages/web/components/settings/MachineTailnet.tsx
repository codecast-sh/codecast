"use client";

import { Check } from "lucide-react";
import { peerLinkState, tailnetShortName, type PeerLinkState } from "@codecast/shared/contracts/peerTransport";
import { useInboxStore } from "../../store/inboxStore";
import { localDeviceIdOf } from "../../hooks/useLocalDeviceId";
import { deviceDisplayName, type Device } from "../DeviceBadge";
import { Switch } from "../ui/switch";
import { SettingsBadge } from "./ui";

const INSTALL_URL = "https://tailscale.com/download";
const LOGIN_URL = "https://login.tailscale.com/";
const USERSPACE_URL = "https://tailscale.com/kb/1112/userspace-networking";

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

function Action({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-meta text-sol-cyan underline underline-offset-2">
      {children}
    </a>
  );
}

function fixFor(why: Why, peer: Device, self: Device, enable: () => void) {
  switch (why) {
    case "self_off":
    case "peer_off":
      return <Action href={INSTALL_URL}>Install Tailscale on {deviceDisplayName(why === "self_off" ? self : peer)}</Action>;
    case "other_account":
    case "different_tailnet":
      return <Action href={LOGIN_URL}>Sign in on {deviceDisplayName(peer)}</Action>;
    case "not_bindable":
      return <Action href={USERSPACE_URL}>Fix on {deviceDisplayName(peer)}</Action>;
    case "disabled":
      return (
        <button type="button" onClick={enable} className="text-meta text-sol-cyan underline underline-offset-2">
          Turn on
        </button>
      );
    default:
      return null;
  }
}

/**
 * One machine's place on Tailscale (Settings → Machines): its tailnet chip,
 * how files from it reach the machine this window runs on, and its "Accept
 * direct links" switch (peer-transport.md). `self` defaults to this window's
 * machine; without one (a plain browser) no pair is shown.
 */
export function MachineTailnet({ device, self: selfProp }: { device: Device; self?: Device | null }) {
  const storeSelf = useInboxStore((s) => {
    const id = localDeviceIdOf(s);
    return id ? ((s.machineRoster as Device[]).find((d) => d.device_id === id) ?? null) : null;
  });
  const self = selfProp === undefined ? storeSelf : selfProp;
  const setDirectLinks = useInboxStore((s) => s.setDeviceDirectLinks);
  const isSelf = self?.device_id === device.device_id;
  const accepts = !device.direct_links_off;
  const enable = () => setDirectLinks(device.device_id, true);

  const pair = self && !isSelf
    ? peerLinkState({
        self: self.tailnet,
        peer: device.tailnet,
        peerOnline: device.online,
        directLinks: accepts,
        last: device.peer_links?.find((l) => l.to_device_id === self.device_id),
      })
    : null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-machine-tailnet={device.device_id}>
      {device.tailnet ? (
        <SettingsBadge tone="cyan" title={device.tailnet.tailnet ?? undefined}>Tailscale · {tailnetShortName(device.tailnet.name)}</SettingsBadge>
      ) : (
        <SettingsBadge tone="muted">No Tailscale</SettingsBadge>
      )}
      {device.tailnet?.bindable === false && <SettingsBadge tone="yellow">Userspace mode</SettingsBadge>}
      {!device.tailnet && isSelf && <Action href={INSTALL_URL}>Install Tailscale</Action>}
      {pair?.state === "direct" && (
        <SettingsBadge tone="green" data-pair="direct" title={pair.proven ? "Proven" : "Untested"}>
          {pair.proven ? <Check className="mr-1 h-3 w-3" aria-label="Proven" /> : <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current" aria-label="Untested" />}
          Direct
        </SettingsBadge>
      )}
      {pair?.state === "relayed" && self && (
        <>
          <SettingsBadge tone="neutral" data-pair="relay" title={pair.reason}>Relay · {WHY_LABEL[pair.why]}</SettingsBadge>
          {fixFor(pair.why, device, self, enable)}
        </>
      )}
      <label className="ml-auto flex items-center gap-2 text-meta text-sol-text-muted">
        Accept direct links
        <Switch checked={accepts} onCheckedChange={(on) => setDirectLinks(device.device_id, on)} aria-label={`Accept direct links on ${deviceDisplayName(device)}`} />
      </label>
    </div>
  );
}
