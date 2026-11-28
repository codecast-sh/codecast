"use client";

// Which machine the open vault is on, and the switch to the same repository
// on the other one. Shown only when more than one machine is in play: a cloud
// host's vault, a host's notes mirror, a local checkout standing in for a
// host that could not be reached, or a local vault whose repository this
// window also holds on a host. Someone with only this machine never sees it.
//
// Each segment is a machine: the open one carries the device accent, the
// other is a button when that machine has the same checkout. A mirror shows
// its lock in place of the live dot, so read-only is the segment's state. A
// machine out of reach shows an offline mark; when it is the open one, its
// segment is the reconnect button (the file tree and language servers wait
// for that host's next forward, and this is the person's way to ask for it).
// While this machine's own daemon is still being reached after a cached boot,
// the bar holds one reconnect chip instead.

import { Loader2, Lock, RotateCw, WifiOff } from "lucide-react";
import { DeviceDot, DeviceIcon, deviceAccentClasses, deviceDisplayName, useRosterDevice, type Device } from "../../../components/DeviceBadge";
import { localEndpointOf, useVaultStore } from "../../../store/vaultStore";
import { filesHref } from "../vaultHref";
import { counterpartPath, hostPathFor, joinVaultPath as join } from "./hostVaults";
import { hostOfVault } from "./routes";

const barClass = "flex items-center gap-2 px-3 py-1 border-b border-sol-border/30 bg-sol-bg-alt/40";

type SegmentState = "live" | "connecting" | "unreachable" | "mirror";

interface Segment {
  deviceId: string;
  state: SegmentState;
  /** Where pressing it goes; absent on the open machine or when the other
   *  machine has no such checkout. */
  href?: string;
}

export function VaultMachineBar({ activePath, onNavigate }: { activePath: string | null; onNavigate: (href: string) => void }) {
  // Field by field: the bar never re-renders on a file event or a body fetch.
  const s = {
    vaults: useVaultStore((st) => st.vaults),
    activeVaultId: useVaultStore((st) => st.activeVaultId),
    isRemote: useVaultStore((st) => st.isRemote),
    remoteVaults: useVaultStore((st) => st.remoteVaults),
    localEndpoint: useVaultStore(localEndpointOf),
    hostStates: useVaultStore((st) => st.hostStates),
    hostFallback: useVaultStore((st) => st.hostFallback),
    connectHost: useVaultStore((st) => st.connectHost),
    connection: useVaultStore((st) => st.connection),
  };
  const vault = s.vaults.find((v) => v.id === s.activeVaultId);
  const mirror = s.isRemote ? s.remoteVaults.find((v) => v.id === s.activeVaultId) : undefined;
  const host = hostOfVault(s.activeVaultId);
  const localId = s.localEndpoint?.deviceId ?? null;

  let current: Segment | null = null;
  let other: Segment | null = null;
  if (mirror) {
    current = { deviceId: mirror.device_id, state: "mirror" };
    const abs = join(mirror.root, activePath);
    const local = localId ? counterpartPath(abs, mirror.device_id, s.vaults) : null;
    // The live host is the better copy: offering it retries the forward.
    other = local && localId
      ? { deviceId: localId, state: "live", href: filesHref({ localPath: local.abs }) }
      : { deviceId: mirror.device_id, state: "unreachable", href: filesHref({ localPath: abs, device: mirror.device_id }) };
  } else if (vault && host) {
    const state = s.hostStates[host] === "connected" ? "live" : (s.hostStates[host] ?? "connecting");
    current = { deviceId: host, state };
    const local = localId ? counterpartPath(join(vault.root, activePath), host, s.vaults) : null;
    if (localId) other = { deviceId: localId, state: "live", href: local ? filesHref({ localPath: local.abs }) : undefined };
  } else if (vault && localId) {
    const abs = join(vault.root, activePath);
    const fallback = s.hostFallback?.localVaultId === vault.id ? s.hostFallback : null;
    const onHost = fallback ? null : counterpartPath(abs, null, s.vaults);
    const hostId = fallback?.deviceId ?? onHost?.deviceId ?? null;
    if (hostId) {
      current = { deviceId: localId, state: "live" };
      other = {
        deviceId: hostId,
        state: s.hostStates[hostId] === "connected" ? "live" : (s.hostStates[hostId] ?? "unreachable"),
        href: filesHref({ localPath: onHost?.abs ?? (fallback ? hostPathFor(fallback.hostAbs, vault.root, activePath) : abs), device: hostId }),
      };
    }
  }
  // This machine's daemon not answered yet, the tree and files painted from
  // the cache: the bar says so, and pressing it asks again. (A host vault's
  // reconnect is its own segment's.)
  if (!current && s.connection === "cached" && !host) {
    return (
      <div className={barClass} data-vault-machine-bar>
        <button
          type="button"
          onClick={() => void useVaultStore.getState().reconnect()}
          title="Cached copy. Reconnect to this machine"
          className="inline-flex items-center gap-1.5 rounded border border-sol-border/40 px-1.5 py-0.5 text-meta text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
          data-reconnect-local
        >
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
          <span>cached</span>
          <RotateCw className="w-3 h-3" aria-hidden />
        </button>
      </div>
    );
  }
  if (!current) return null;

  const go = (seg: Segment) => {
    if (!seg.href) return;
    // A host that was out of reach is asked again; the link waits for the answer.
    if (seg.deviceId !== localId && s.hostStates[seg.deviceId] !== "connected") void s.connectHost(seg.deviceId);
    onNavigate(seg.href);
  };

  return (
    <div className={barClass} data-vault-machine-bar>
      <div role="group" aria-label="Machine" className="inline-flex items-center rounded border border-sol-border/40 p-px gap-px">
        <MachineSegment
          seg={current}
          active
          onPress={host && current.state === "unreachable" ? () => void s.connectHost(host) : undefined}
        />
        {other && <MachineSegment seg={other} onPress={() => go(other!)} />}
      </div>
    </div>
  );
}

function MachineSegment({ seg, active = false, onPress }: { seg: Segment; active?: boolean; onPress?: () => void }) {
  const roster = useRosterDevice(seg.deviceId);
  const d: Pick<Device, "platform"> & { is_remote?: boolean } = roster ?? { platform: "", is_remote: true };
  const name = roster ? deviceDisplayName(roster) : seg.deviceId.slice(0, 8);
  const tone = active && roster ? deviceAccentClasses(roster) : active ? "bg-sol-violet/10 text-sol-violet border-sol-violet/30" : "border-transparent text-sol-text-muted";
  const status = (
    <>
      {seg.state === "mirror" && <Lock className="w-3 h-3" aria-label="Read-only mirror" />}
      {seg.state === "connecting" && <Loader2 className="w-3 h-3 animate-spin" aria-label="Connecting" />}
      {seg.state === "live" && <DeviceDot online />}
      {seg.state === "unreachable" && <WifiOff className="w-3 h-3 text-sol-red" aria-label="Not reachable" />}
    </>
  );
  const title =
    seg.state === "mirror" ? `${name}: read-only mirror` : seg.state === "unreachable" ? `${name}: not reachable` : seg.state === "connecting" ? `${name}: connecting` : name;
  const cls = `inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-meta border max-w-[180px] ${tone}`;
  const body = (
    <>
      <DeviceIcon d={d} />
      <span className="truncate">{name}</span>
      {seg.state === "mirror" && <span className="text-sol-text-dim">mirror</span>}
      {status}
    </>
  );
  if (active && onPress) {
    return (
      <button
        type="button"
        className={`${cls} hover:bg-sol-bg-alt hover:text-sol-text`}
        title={`${name}: not reachable. Reconnect`}
        aria-current="true"
        onClick={onPress}
        data-reconnect-host
      >
        {body}
        <RotateCw className="w-3 h-3" aria-hidden />
      </button>
    );
  }
  if (active) return <span className={cls} title={title} aria-current="true">{body}</span>;
  return (
    <button
      type="button"
      className={`${cls} enabled:hover:bg-sol-bg-alt enabled:hover:text-sol-text disabled:opacity-40`}
      title={seg.href ? `Open on ${name}` : `${name} has no checkout of this folder`}
      disabled={!seg.href}
      onClick={onPress}
    >
      {body}
    </button>
  );
}
