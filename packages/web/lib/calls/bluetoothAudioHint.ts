// Detecting the macOS / Bluetooth Hands-Free Profile (HFP) quality trap.
//
// When a Bluetooth headset (AirPods, Sony WH/WF, Bose, Beats, Jabra) is opened
// as BOTH speaker and microphone, macOS CoreAudio drops the entire Bluetooth
// link from 48 kHz stereo A2DP down to 16 kHz / 8 kHz mono HFP/SCO — making
// everyone else in the huddle sound muffled while capturing through a tiny
// narrowband ear-cup mic. Keeping the headphones for output and switching the
// input to a built-in or USB mic restores full-band 48 kHz audio both ways.

export type DeviceInfoLike = Pick<MediaDeviceInfo, "deviceId" | "label">;

const BLUETOOTH_RE =
  /\(bluetooth\)|\b(airpods|beats|powerbeats|wh-1000x|wf-1000x|linkbuds|quietcomfort|bose\s*(?:nc|700|head|ultra)|jabra\s*evolve|galaxy\s*buds|pixel\s*buds|momentum\s*(?:true|\d)|nothing\s*ear|anker\s*soundcore)\b/i;

const VIRTUAL_MIC_RE =
  /\b(virtual|blackhole|loopback|soundflower|zoomaudio|teamsaudio|vb-cable|ndi\s*audio)\b/i;

const PREFERRED_LOCAL_MIC_RE =
  /\(built-in\)|\b(macbook|studio\s*display|imac|mac\s*pro|mac\s*mini|built-in|internal|shure|yeti|blue\s*microphones|rode|røde|elgato|wave:\d|scarlett|focusrite|audio-technica|at2020|fifine|hyperx\s*quadcast|samson)\b/i;

export function cleanDeviceLabel(label: string | undefined): string {
  if (!label) return "";
  return label
    .replace(/^(Default|Communications)\s*-\s*/i, "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
}

export function isBluetoothAudioDevice(label: string | undefined): boolean {
  if (!label) return false;
  return BLUETOOTH_RE.test(label);
}

function resolveSelected(devices: DeviceInfoLike[], chosenId: string | undefined): DeviceInfoLike | undefined {
  if (devices.length === 0) return undefined;
  if (chosenId) {
    const exact = devices.find((d) => d.deviceId === chosenId);
    if (exact) return exact;
  }
  return devices.find((d) => d.deviceId === "default") ?? devices[0];
}

export type BluetoothHfpConflict = {
  headsetName: string;
  altMic: DeviceInfoLike;
  altMicName: string;
};

/**
 * Returns a one-click alternative microphone when the active mic and speaker
 * both resolve to a Bluetooth headset and a non-Bluetooth physical mic exists.
 */
export function bluetoothHfpConflict(
  mics: DeviceInfoLike[],
  speakers: DeviceInfoLike[],
  chosenMicId?: string,
  chosenSpeakerId?: string,
): BluetoothHfpConflict | null {
  const mic = resolveSelected(mics, chosenMicId);
  const speaker = resolveSelected(speakers, chosenSpeakerId);
  if (!mic?.label) return null;

  const micBt = isBluetoothAudioDevice(mic.label);
  if (!micBt) return null;

  // On Safari (where speakers aren't enumerated), opening a Bluetooth mic still
  // forces HFP whenever that headset is worn; when speakers ARE listed, only
  // flag when the active speaker is also Bluetooth (or shares the headset name).
  const micClean = cleanDeviceLabel(mic.label);
  if (speakers.length > 0 && speaker?.label) {
    const speakerClean = cleanDeviceLabel(speaker.label);
    const sameHeadset =
      isBluetoothAudioDevice(speaker.label) ||
      (!!micClean && !!speakerClean && micClean.toLowerCase() === speakerClean.toLowerCase());
    if (!sameHeadset) return null;
  }

  const candidates = mics.filter(
    (d) =>
      d.deviceId &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications" &&
      d.deviceId !== mic.deviceId &&
      !!d.label &&
      !isBluetoothAudioDevice(d.label) &&
      !VIRTUAL_MIC_RE.test(d.label),
  );
  if (candidates.length === 0) return null;

  const altMic =
    candidates.find((d) => PREFERRED_LOCAL_MIC_RE.test(d.label)) ?? candidates[0]!;
  return {
    headsetName: micClean || "Bluetooth headphones",
    altMic,
    altMicName: cleanDeviceLabel(altMic.label) || altMic.label,
  };
}
