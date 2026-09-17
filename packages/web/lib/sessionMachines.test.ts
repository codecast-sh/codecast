import { describe, expect, test } from "bun:test";
import {
  cloudHostOf,
  cloudToggleAvailable,
  defaultSessionMachineId,
  isCloudHost,
  machineSelectionAfterCloudToggle,
  machineSelectionAfterPick,
  sessionMachineChoices,
} from "./sessionMachines";

const laptop = { device_id: "laptop", label: "My Mac", platform: "darwin", online: true, is_remote: false, last_seen: 1, local_project_roots: ["/Users/me/src/app"] };
const mini = { ...laptop, device_id: "agent-box", label: "Mac-mini", bot_name: "Mr Bot", local_project_roots: ["/Users/bot/src/app"] };
const cloud = { device_id: "cloud", label: "Linux - ip-172-31-40-243", platform: "linux", online: false, is_remote: true, last_seen: 0, local_project_roots: ["/home/ubuntu/work/app"] };
const cloudAwake = { ...cloud, online: true };
const remoteMac = { device_id: "remote-mac", label: "Remote", platform: "darwin", online: true, is_remote: true, last_seen: 1, local_project_roots: [] };
const linuxLaptop = { device_id: "linux-laptop", label: "thinkpad", platform: "linux", online: true, is_remote: false, last_seen: 1, local_project_roots: [] };
const linuxBox = { ...cloud, device_id: "linux-box", bot_name: "Boxy" };

describe("new-session machines", () => {
  test("adds team agent boxes with their own folders", () => {
    expect(sessionMachineChoices([laptop], [mini])).toEqual([laptop, mini]);
  });

  test("a cloned device id never shadows the viewer's own machine", () => {
    expect(sessionMachineChoices([laptop], [{ ...mini, device_id: laptop.device_id }])).toEqual([laptop]);
  });

  test("keeps the normal default until an agent box is explicitly chosen", () => {
    expect(defaultSessionMachineId([mini, laptop], {})).toBe(laptop.device_id);
    expect(defaultSessionMachineId([mini, laptop], { lastPicked: mini.device_id })).toBe(mini.device_id);
  });

  test("an existing box session stays on its machine", () => {
    expect(defaultSessionMachineId([mini, laptop], { ownerDeviceId: mini.device_id, lastPicked: laptop.device_id })).toBe(mini.device_id);
  });

  test("handles a box-only account and a stale saved pick", () => {
    expect(defaultSessionMachineId([mini], {})).toBe(mini.device_id);
    expect(defaultSessionMachineId([{ ...mini, online: false }, laptop], { lastPicked: mini.device_id })).toBe(laptop.device_id);
  });
});

describe("isCloudHost / cloudHostOf — the machine the toggle points at", () => {
  test("true only for the user's own remote Linux box", () => {
    expect(isCloudHost(cloud)).toBe(true);
    expect(isCloudHost(cloudAwake)).toBe(true);
    expect(isCloudHost(remoteMac)).toBe(false);
    expect(isCloudHost(linuxLaptop)).toBe(false);
    expect(isCloudHost(linuxBox)).toBe(false);
    expect(isCloudHost(mini)).toBe(false);
  });

  test("cloudHostOf returns the host even while it sleeps, null without one", () => {
    expect(cloudHostOf([laptop, cloud])).toBe(cloud);
    expect(cloudHostOf([laptop, linuxBox, remoteMac])).toBeNull();
    expect(cloudHostOf([])).toBeNull();
  });
});

describe("the ladder honours an asleep cloud host", () => {
  test("an OFFLINE cloud host holds as owner and as the standing pick", () => {
    expect(defaultSessionMachineId([laptop, cloud], { ownerDeviceId: cloud.device_id })).toBe(cloud.device_id);
    expect(defaultSessionMachineId([laptop, cloud], { lastPicked: cloud.device_id })).toBe(cloud.device_id);
  });

  test("an offline laptop pick and an offline agent box pick are ignored", () => {
    expect(defaultSessionMachineId([{ ...laptop, online: false }, linuxLaptop], { lastPicked: laptop.device_id })).toBe(linuxLaptop.device_id);
    expect(defaultSessionMachineId([{ ...linuxBox, online: false }, laptop], { lastPicked: linuxBox.device_id })).toBe(laptop.device_id);
  });

  test("owner=laptop outranks lastPicked=cloud host", () => {
    expect(defaultSessionMachineId([laptop, cloud], { ownerDeviceId: laptop.device_id, lastPicked: cloud.device_id })).toBe(laptop.device_id);
  });

  test("with no owner and no pick the online laptop wins over the host", () => {
    expect(defaultSessionMachineId([cloud, laptop], {})).toBe(laptop.device_id);
  });
});

describe("transitions keep cloudMode === isCloudHost(picked)", () => {
  const devices = [laptop, mini, cloud];
  const invariant = (sel: { pickedDeviceId: string | null; cloudMode: boolean }, pool = devices) => {
    if (sel.pickedDeviceId === null) return;
    const picked = pool.find((d) => d.device_id === sel.pickedDeviceId)!;
    expect(picked).toBeDefined();
    expect(sel.cloudMode).toBe(isCloudHost(picked));
  };

  test("a chip pick derives cloud mode from the chip", () => {
    const onCloud = machineSelectionAfterPick(cloud);
    expect(onCloud).toEqual({ pickedDeviceId: "cloud", cloudMode: true });
    invariant(onCloud);
    const onLaptop = machineSelectionAfterPick(laptop);
    expect(onLaptop).toEqual({ pickedDeviceId: "laptop", cloudMode: false });
    invariant(onLaptop);
    const onBox = machineSelectionAfterPick(mini);
    expect(onBox.cloudMode).toBe(false);
    invariant(onBox);
  });

  test("toggle on picks the (offline) cloud host; with none it stays off", () => {
    const on = machineSelectionAfterCloudToggle(devices, {}, true);
    expect(on).toEqual({ pickedDeviceId: "cloud", cloudMode: true });
    invariant(on);
    expect(machineSelectionAfterCloudToggle([laptop, mini], {}, true)).toEqual({ pickedDeviceId: null, cloudMode: false });
  });

  test("toggle off with the standing pick on the host lands on a non-cloud machine", () => {
    const off = machineSelectionAfterCloudToggle([laptop, cloudAwake], { lastPicked: cloudAwake.device_id }, false);
    expect(off).toEqual({ pickedDeviceId: "laptop", cloudMode: false });
    invariant(off, [laptop, cloudAwake]);
  });

  test("toggle off on a cloud-only roster yields null and the toggle is unavailable", () => {
    expect(machineSelectionAfterCloudToggle([cloud], { lastPicked: cloud.device_id }, false)).toEqual({ pickedDeviceId: null, cloudMode: false });
    expect(cloudToggleAvailable([cloud], true)).toBe(false);
    expect(cloudToggleAvailable([cloud], false)).toBe(true);
    expect(cloudToggleAvailable([laptop, cloud], true)).toBe(true);
    expect(cloudToggleAvailable([laptop, mini], false)).toBe(false);
  });

  test("toggle off for a row parked on the host does not keep the host as owner", () => {
    const off = machineSelectionAfterCloudToggle(devices, { ownerDeviceId: cloud.device_id }, false);
    expect(off).toEqual({ pickedDeviceId: "laptop", cloudMode: false });
    invariant(off);
  });
});
