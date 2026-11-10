import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// listDevices re-sends the whole roster, freshly decoded, whenever any
// device's minute-bucketed last_seen moves. A push wakes only the readers of
// devices that changed: unchanged devices keep their references, a push that
// changes nothing writes nothing, and the live flag still flips on the first
// push (the path-seeding gate waits on it).

const device = (id: string, extra: Record<string, unknown> = {}) => ({
  device_id: id, is_remote: false, online: true, last_seen: 60_000, platform: "darwin",
  local_project_roots: ["/Users/ada/src"], ...extra,
}) as any;
const fresh = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe("setMachineRoster", () => {
  beforeEach(() => {
    useInboxStore.setState({ machineRoster: [], machineRosterLive: false } as any);
  });

  it("flips the live flag on the first push even when the roster is unchanged", () => {
    useInboxStore.setState({ machineRoster: [device("a")] } as any);
    const before = useInboxStore.getState().machineRoster;
    useInboxStore.getState().setMachineRoster(fresh([device("a")]));
    expect(useInboxStore.getState().machineRosterLive).toBe(true);
    expect(useInboxStore.getState().machineRoster).toBe(before);
  });

  it("writes nothing for a value-identical push", () => {
    useInboxStore.getState().setMachineRoster([device("a"), device("b")]);
    const state = useInboxStore.getState();
    useInboxStore.getState().setMachineRoster(fresh([device("a"), device("b")]));
    expect(useInboxStore.getState()).toBe(state);
  });

  it("keeps unchanged devices at their old reference and takes the changed one", () => {
    useInboxStore.getState().setMachineRoster([device("a"), device("b")]);
    const [a, b] = useInboxStore.getState().machineRoster as any[];
    useInboxStore.getState().setMachineRoster(fresh([device("a"), device("b", { last_seen: 120_000 })]));
    const [a2, b2] = useInboxStore.getState().machineRoster as any[];
    expect(a2).toBe(a);
    expect(b2).not.toBe(b);
    expect(b2.last_seen).toBe(120_000);
  });

  it("takes membership and order changes", () => {
    useInboxStore.getState().setMachineRoster([device("a"), device("b")]);
    useInboxStore.getState().setMachineRoster(fresh([device("b"), device("a")]));
    expect((useInboxStore.getState().machineRoster as any[]).map((d) => d.device_id)).toEqual(["b", "a"]);
    useInboxStore.getState().setMachineRoster(fresh([device("b")]));
    expect((useInboxStore.getState().machineRoster as any[]).map((d) => d.device_id)).toEqual(["b"]);
    useInboxStore.getState().setMachineRoster([]);
    expect(useInboxStore.getState().machineRoster).toEqual([]);
  });
});
