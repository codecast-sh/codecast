// The roster feeder is a no-op in the preview: the store mock already holds
// the fixture devices.
export function useSyncDevices(): { ready: boolean } {
  return { ready: true };
}

export function liveMachineRoster(s: { machineRoster: any[] }): any[] {
  return s.machineRoster;
}
