import { describe, expect, test } from "bun:test";
import { defaultSessionMachineId, sessionMachineChoices } from "./sessionMachines";

const laptop = { device_id: "laptop", label: "My Mac", platform: "darwin", online: true, is_remote: false, last_seen: 1, local_project_roots: ["/Users/me/src/app"] };
const mini = { ...laptop, device_id: "agent-box", label: "Mac-mini", bot_name: "Mr Bot", local_project_roots: ["/Users/bot/src/app"] };

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
