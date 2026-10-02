// The device pickers, shared by the stage's control bar and the call settings
// panel. One source, because "which microphone" has to mean the same thing
// everywhere: every picker writes through `switchDevice`, which switches the
// live room AND remembers the choice for the next join, and every picker reads
// the remembered choice back from the store, so no two surfaces can disagree
// about what was chosen.
import { useCallback, useRef, useState } from "react";
import { Check, ChevronUp, Mic, Video, type LucideIcon } from "lucide-react";
import { grantDeviceNames, listDevices, switchDevice } from "../../lib/calls/callManager";
import { DEVICE_PREF_KEY } from "../../lib/calls/joinPrefs";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";

type Kind = keyof typeof DEVICE_PREF_KEY;
type Lists = Record<Kind, MediaDeviceInfo[]>;

const KIND_WORD: Record<Kind, string> = { audioinput: "Microphone", audiooutput: "Speaker", videoinput: "Camera" };
const KINDS: Kind[] = ["audioinput", "audiooutput", "videoinput"];

// The browser's device lists, refreshed when a device is plugged in or pulled.
// null until the first list lands, so nothing flashes "no devices" at a
// machine that has them. Listing never asks for permission: opening settings
// must not raise a dialog. Inside a call the device is already open, so names
// come anyway.
function useDeviceLists() {
  const [lists, setLists] = useState<Lists | null>(null);
  const refresh = useCallback(async () => {
    const [a, b, c] = await Promise.all(KINDS.map((k) => listDevices(k, { prompt: false })));
    setLists({ audioinput: a, audiooutput: b, videoinput: c });
  }, []);
  useMountEffect(() => {
    void refresh();
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const onChange = () => void refresh();
    md?.addEventListener?.("devicechange", onChange);
    return () => md?.removeEventListener?.("devicechange", onChange);
  });
  return { lists, refresh };
}

// The device a join will open for this kind: the remembered pick while it is
// still plugged in, else the system default, else whatever the browser lists
// first. Subscribed, so a pick made in a second window shows here too.
function useChosenId(kind: Kind, devices: MediaDeviceInfo[] | undefined): string {
  const remembered = useInboxStore((s) => (s.clientState?.ui as any)?.[DEVICE_PREF_KEY[kind]] ?? "");
  if (!devices?.length) return "";
  if (devices.some((d) => d.deviceId === remembered)) return remembered;
  return (devices.find((d) => d.deviceId === "default") ?? devices[0]).deviceId;
}

// Chrome names the system default "Default - AirPods Pro (Bluetooth)" and USB
// devices "Logitech BRIO (046d:085e)". The person wants the device, not the
// plumbing, so the prefix and the trailing parenthetical both go.
function deviceName(d: MediaDeviceInfo | undefined, kind: Kind, index = 0): string {
  if (!d?.label) return `${KIND_WORD[kind]} ${index + 1}`;
  return d.label.replace(/^(Default|Communications) - /, "").replace(/\s*\([^()]*\)$/, "");
}

// Without permission the browser lists devices but withholds their names. A
// picker of "Microphone 1, Microphone 2" is no picker, so the honest offer is
// one grant, released the moment it lands.
function NameMyDevices({ lists, refresh }: { lists: Lists; refresh: () => Promise<void> }) {
  if (!KINDS.some((k) => lists[k].some((d) => !d.label))) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-sol-bg-alt px-2.5 py-2">
      <span className="text-xs leading-snug text-sol-text-muted">
        Allow the microphone and camera once and these show their names.
      </span>
      <button
        type="button"
        onClick={() => void grantDeviceNames().then(refresh)}
        className="shrink-0 rounded-md border border-sol-border px-2 py-1 text-xs text-sol-text hover:border-sol-text-muted"
      >
        Name my devices
      </button>
    </div>
  );
}

function DeviceSelect({ kind, devices, compact }: { kind: Kind; devices: MediaDeviceInfo[]; compact: boolean }) {
  const value = useChosenId(kind, devices);
  if (devices.length === 0) return null;
  return (
    <label className="block">
      <span className={`uppercase tracking-wide text-sol-text-muted ${compact ? "text-[10px]" : "text-[11px]"}`}>
        {KIND_WORD[kind]}
      </span>
      <select
        value={value}
        onChange={(e) => void switchDevice(kind, e.target.value)}
        className={`mt-0.5 w-full rounded-md bg-sol-bg px-1.5 py-1 text-sol-text outline-none focus:ring-1 focus:ring-sol-cyan/60 ${
          compact ? "text-[11px]" : "text-xs"
        }`}
      >
        <DeviceOptions kind={kind} devices={devices} />
      </select>
    </label>
  );
}

function DeviceOptions({ kind, devices }: { kind: Kind; devices: MediaDeviceInfo[] }) {
  return (
    <>
      {devices.map((d, i) => (
        <option key={d.deviceId || i} value={d.deviceId}>
          {d.deviceId === "default" ? `System default (${deviceName(d, kind, i)})` : deviceName(d, kind, i)}
        </option>
      ))}
    </>
  );
}

/** The microphone alone, as a bare select, for a surface that records without
 *  a room (the meeting recorder). Same write path as every other picker. */
export function MicSelect({ className = "" }: { className?: string }) {
  const { lists } = useDeviceLists();
  const devices = lists?.audioinput ?? [];
  const value = useChosenId("audioinput", devices);
  if (devices.length === 0) return null;
  return (
    <select
      value={value}
      onChange={(e) => void switchDevice("audioinput", e.target.value)}
      title="Microphone"
      aria-label="Microphone"
      className={className}
    >
      <DeviceOptions kind="audioinput" devices={devices} />
    </select>
  );
}

/** Every device as a select, for the call settings panel. */
export function DeviceRows({ compact = false }: { compact?: boolean }) {
  const { lists, refresh } = useDeviceLists();
  if (!lists) return null;
  if (KINDS.every((k) => lists[k].length === 0)) {
    return <p className="text-xs leading-relaxed text-sol-text-muted">No microphone, speaker or camera found on this machine.</p>;
  }
  return (
    <>
      <NameMyDevices lists={lists} refresh={refresh} />
      {KINDS.map((k) => (
        <DeviceSelect key={k} kind={k} devices={lists[k]} compact={compact} />
      ))}
    </>
  );
}

function DeviceList({ kind, devices }: { kind: Kind; devices: MediaDeviceInfo[] }) {
  const chosen = useChosenId(kind, devices);
  if (devices.length === 0) return null;
  return (
    <section>
      <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-sol-text-dim">{KIND_WORD[kind]}</div>
      {devices.map((d, i) => {
        const on = d.deviceId === chosen;
        return (
          <button
            key={d.deviceId || i}
            type="button"
            onClick={() => void switchDevice(kind, d.deviceId)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06] ${
              on ? "text-sol-text" : "text-sol-text-muted"
            }`}
          >
            <Check className={`h-3.5 w-3.5 shrink-0 text-sol-cyan ${on ? "" : "invisible"}`} />
            <span className="min-w-0 truncate">
              {d.deviceId === "default" ? (
                <>
                  System default <span className="text-sol-text-dim">· {deviceName(d, kind, i)}</span>
                </>
              ) : (
                deviceName(d, kind, i)
              )}
            </span>
          </button>
        );
      })}
    </section>
  );
}

const CHIPS: Array<{ kind: Kind; icon: LucideIcon; menu: Kind[] }> = [
  { kind: "audioinput", icon: Mic, menu: ["audioinput", "audiooutput"] },
  { kind: "videoinput", icon: Video, menu: ["videoinput"] },
];

/**
 * The stage's device line: the microphone and camera the call is using, named,
 * each one a click away from its picker. The speaker rides with the mic,
 * because "I can't hear" and "they can't hear me" are the same trip.
 */
export function DeviceChips({ footer }: { footer?: React.ReactNode }) {
  const { lists, refresh } = useDeviceLists();
  const [open, setOpen] = useState<Kind | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A click outside or Escape closes the open picker; nothing listens while closed.
  const dismissTarget = open ? window : null;
  useEventListener("pointerdown", (e) => {
    if (!root.current?.contains(e.target as Node)) setOpen(null);
  }, dismissTarget);
  useEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(null);
  }, dismissTarget);
  if (!lists) return null;
  return (
    <div ref={root} className="relative flex items-center justify-center gap-1">
      {CHIPS.map(({ kind, icon, menu }) =>
        lists[kind].length === 0 ? null : (
          <Chip
            key={kind}
            kind={kind}
            icon={icon}
            devices={lists[kind]}
            active={open === kind}
            onClick={() => setOpen((o) => (o === kind ? null : kind))}
          />
        ),
      )}
      {open && (
        <div className="absolute bottom-full left-1/2 z-10 mb-2 w-[280px] -translate-x-1/2 space-y-2 rounded-xl bg-sol-bg-alt p-1.5 shadow-2xl ring-1 ring-white/5">
          <NameMyDevices lists={lists} refresh={refresh} />
          {CHIPS.find((c) => c.kind === open)!.menu.map((k) => (
            <DeviceList key={k} kind={k} devices={lists[k]} />
          ))}
          {open === "videoinput" && footer}
        </div>
      )}
    </div>
  );
}

function Chip({
  kind,
  icon: Icon,
  devices,
  active,
  onClick,
}: {
  kind: Kind;
  icon: LucideIcon;
  devices: MediaDeviceInfo[];
  active: boolean;
  onClick: () => void;
}) {
  const chosen = useChosenId(kind, devices);
  const index = devices.findIndex((d) => d.deviceId === chosen);
  const name = deviceName(devices[index], kind, index);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${KIND_WORD[kind]}: ${name}. Click to change.`}
      className={`flex items-center rounded-full px-1.5 py-0.5 text-[11px] transition-[color,background-color,opacity] duration-200 ${
        active
          ? "bg-white/10 text-sol-text"
          : "text-sol-text-dim opacity-50 hover:bg-white/[0.06] hover:text-sol-text-muted group-hover/ctl:opacity-100 group-focus-within/ctl:opacity-100"
      }`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {/* Folded to the glyph until the pointer reaches the controls, so the
          bar at rest is the call, not its plumbing. */}
      <span
        className={`min-w-0 truncate transition-[max-width,opacity,margin] duration-200 ease-out ${
          active
            ? "ml-1.5 max-w-[150px] opacity-100"
            : "ml-0 max-w-0 opacity-0 group-hover/ctl:ml-1.5 group-hover/ctl:max-w-[150px] group-hover/ctl:opacity-100 group-focus-within/ctl:ml-1.5 group-focus-within/ctl:max-w-[150px] group-focus-within/ctl:opacity-100"
        }`}
      >
        {name}
      </span>
      <ChevronUp className={`ml-0.5 h-3 w-3 shrink-0 transition-transform ${active ? "" : "rotate-180"}`} />
    </button>
  );
}
