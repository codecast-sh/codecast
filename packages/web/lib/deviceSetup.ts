export const OPEN_EVENT = "codecast-device-setup-open";

export function openDeviceSetup(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

// The device-setup dialog opens once per device. The stamp is local to this
// device on purpose: the synced dismissed bag would let one machine's answer
// silence a fresh one. The setup flow asks the same permissions in place and
// stamps it too, so the dialog never repeats the ask on arrival.
const SEEN_KEY = "codecast.deviceSetup.v1";

export function deviceSetupSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) != null;
  } catch {
    return true;
  }
}

export function markDeviceSetupSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {}
}
