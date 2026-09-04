import type { Device } from "../components/DeviceBadge";
import { defaultMachineId, type MachineCandidate } from "./machinePicker";

export type SessionMachine = Device & { bot_name?: string | null };

export function sessionMachineChoices(
  devices: Device[],
  boxes: Array<Omit<Device, "local_project_roots"> & { local_project_roots?: string[]; bot_name: string | null }>,
): SessionMachine[] {
  const ids = new Set(devices.map((d) => d.device_id));
  return [...devices, ...boxes.filter((b) => !ids.has(b.device_id)).map((b) => ({
    ...b,
    local_project_roots: b.local_project_roots ?? [],
  }))];
}

export function defaultSessionMachineId(
  devices: Array<MachineCandidate & { bot_name?: string | null }>,
  opts: Parameters<typeof defaultMachineId>[1],
) {
  const own = devices.filter((d) => d.bot_name === undefined);
  const intended = devices.find((d) => d.device_id === opts?.ownerDeviceId && d.online)
    ?? devices.find((d) => d.device_id === opts?.lastPicked && d.online);
  return intended?.device_id ?? defaultMachineId(own.length ? own : devices, opts);
}
