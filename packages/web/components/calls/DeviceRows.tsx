// The device pickers, shared by the stage's popover and the call settings
// panel. One component, because "which microphone" has to mean the same thing
// in both places: the picker in a live call switches the room AND remembers,
// the picker in settings only remembers, and `switchDevice` is the one path
// that does both, so the two surfaces cannot disagree about what was chosen.
import { useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { listDevices, switchDevice } from "../../lib/calls/callManager";
import { readJoinPrefs } from "../../lib/calls/joinPrefs";
import { useInboxStore } from "../../store/inboxStore";

type Kind = "audioinput" | "audiooutput" | "videoinput";

export function DeviceRows({ compact = false }: { compact?: boolean }) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  // The remembered choice is the picker's VALUE, so it shows the device the
  // next join will open rather than whatever the browser lists first.
  // Subscribed, so a pick made in a second window is reflected here.
  const micId = useInboxStore((s) => s.clientState?.ui?.call_mic_device_id ?? "");
  const camId = useInboxStore((s) => s.clientState?.ui?.call_camera_device_id ?? "");
  useMountEffect(() => {
    let alive = true;
    void Promise.all([listDevices("audioinput"), listDevices("audiooutput"), listDevices("videoinput")]).then(
      ([m, o, c]) => {
        if (!alive) return;
        setMics(m);
        setOuts(o);
        setCams(c);
      },
    );
    return () => {
      alive = false;
    };
  });
  const row = (label: string, devices: MediaDeviceInfo[], kind: Kind, value: string) =>
    devices.length > 0 && (
      <label className="block">
        <span className={`uppercase tracking-wide text-sol-text-muted ${compact ? "text-[10px]" : "text-[11px]"}`}>
          {label}
        </span>
        <select
          value={devices.some((d) => d.deviceId === value) ? value : devices[0]?.deviceId}
          onChange={(e) => void switchDevice(kind, e.target.value)}
          className={`mt-0.5 w-full rounded-md bg-sol-bg px-1.5 py-1 text-sol-text outline-none focus:ring-1 focus:ring-sol-cyan/60 ${
            compact ? "text-[11px]" : "text-xs"
          }`}
        >
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${d.deviceId.slice(0, 4)}`}
            </option>
          ))}
        </select>
      </label>
    );
  const prefs = readJoinPrefs();
  return (
    <>
      {row("Microphone", mics, "audioinput", micId || prefs.micDeviceId || "")}
      {row("Speaker", outs, "audiooutput", "")}
      {row("Camera", cams, "videoinput", camId || prefs.cameraDeviceId || "")}
    </>
  );
}
