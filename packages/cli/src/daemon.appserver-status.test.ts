import { describe, expect, test } from "bun:test";
import { mapCodexAppServerThreadStatusToAgentStatus } from "./daemon.js";

describe("mapCodexAppServerThreadStatusToAgentStatus", () => {
  test("maps idle threads to idle", () => {
    expect(mapCodexAppServerThreadStatusToAgentStatus({ type: "idle" })).toBe("idle");
  });

  test("maps active threads without blockers to working", () => {
    expect(
      mapCodexAppServerThreadStatusToAgentStatus({ type: "active", activeFlags: [] }),
    ).toBe("working");
  });

  test("maps approval and user-input blockers to permission_blocked", () => {
    expect(
      mapCodexAppServerThreadStatusToAgentStatus({ type: "active", activeFlags: ["waitingOnApproval"] }),
    ).toBe("permission_blocked");
    expect(
      mapCodexAppServerThreadStatusToAgentStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }),
    ).toBe("permission_blocked");
  });

  test("maps system errors to stopped and ignores non-loaded states", () => {
    expect(mapCodexAppServerThreadStatusToAgentStatus({ type: "systemError" })).toBe("stopped");
    expect(mapCodexAppServerThreadStatusToAgentStatus({ type: "notLoaded" })).toBeNull();
  });
});
