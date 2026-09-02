// The device pickers, shared by the stage's popover and the call settings
// panel. One component, because "which microphone" has to mean the same thing
// in both places: the picker in a live call switches the room AND remembers,
// the picker in settings only remembers, and `switchDevice` is the one path
// that does both, so the two surfaces cannot disagree about what was chosen.
import { useCallback, useState } from "react";
import { grantDeviceNames, listDevices, switchDevice } from "../../lib/calls/callManager";
import { readJoinPrefs } from "../../lib/calls/joinPrefs";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";

type Kind = "audioinput" | "audiooutput" | "videoinput";
type Lists = { mics: MediaDeviceInfo[]; outs: MediaDeviceInfo[]; cams: MediaDeviceInfo[] } | null;

const KIND_WORD: Record<Kind, string> = { audioinput: "Microphone", audiooutput: "Speaker", videoinput: "Camera" };

export function DeviceRows({ compact = false }: { compact?: boolean }) {
  // null until the first list lands, so the panel never flashes "no devices"
  // at a machine that has them.
  const [lists, setLists] = useState<Lists>(null);
  // The remembered choice is the picker's VALUE, so it shows the device the
  // next join will open rather than whatever the browser lists first.
  // Subscribed, so a pick made in a second window is reflected here.
  const micId = useInboxStore((s) => s.clientState?.ui?.call_mic_device_id ?? "");
  const camId = useInboxStore((s) => s.clientState?.ui?.call_camera_device_id ?? "");
  // The speaker is not a join pref (a room switches its own output), so its
  // pick lives here for the life of the picker — a controlled select with no
  // state behind it snaps back to the first entry after every pick.
  const [outId, setOutId] = useState("");
  // Listing never asks for permission: opening settings must not raise a
  // dialog. Inside a call the device is already open, so names come anyway.
  const refresh = useCallback(async () => {
    const [mics, outs, cams] = await Promise.all([
      listDevices("audioinput", { prompt: false }),
      listDevices("audiooutput", { prompt: false }),
      listDevices("videoinput", { prompt: false }),
    ]);
    setLists({ mics, outs, cams });
  }, []);
  useMountEffect(() => {
    let alive = true;
    void refresh().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
  });
  if (!lists) return null;
  const all = [...lists.mics, ...lists.outs, ...lists.cams];
  if (all.length === 0) {
    return <p className="text-xs leading-relaxed text-sol-text-muted">No microphone, speaker or camera found on this machine.</p>;
  }
  // Without permission the browser lists devices but withholds their names
  // (and sometimes their ids). A picker of "Microphone 1, Microphone 2" is
  // no picker, so the honest offer is one grant, released the moment it lands.
  const unnamed = all.some((d) => !d.label);
  const row = (kind: Kind, devices: MediaDeviceInfo[], value: string, onPick?: (id: string) => void) => {
    const label = KIND_WORD[kind];
    if (devices.length === 0) return null;
    return (
      <label className="block">
        <span className={`uppercase tracking-wide text-sol-text-muted ${compact ? "text-[10px]" : "text-[11px]"}`}>
          {label}
        </span>
        <select
          value={devices.some((d) => d.deviceId === value) ? value : devices[0]?.deviceId}
          onChange={(e) => {
            onPick?.(e.target.value);
            void switchDevice(kind, e.target.value);
          }}
          className={`mt-0.5 w-full rounded-md bg-sol-bg px-1.5 py-1 text-sol-text outline-none focus:ring-1 focus:ring-sol-cyan/60 ${
            compact ? "text-[11px]" : "text-xs"
          }`}
        >
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const prefs = readJoinPrefs();
  return (
    <>
      {unnamed && (
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
      )}
      {row("audioinput", lists.mics, micId || prefs.micDeviceId || "")}
      {row("audiooutput", lists.outs, outId, setOutId)}
      {row("videoinput", lists.cams, camId || prefs.cameraDeviceId || "")}
    </>
  );
}
