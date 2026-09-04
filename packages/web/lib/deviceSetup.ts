

export const OPEN_EVENT = "codecast-device-setup-open";


export function openDeviceSetup(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}
