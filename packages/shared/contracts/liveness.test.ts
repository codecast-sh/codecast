import { describe, expect, test } from "bun:test";
import {
  LIVENESS_VERDICTS,
  authorizesTeardown,
  confineToOwningDevice,
  verdictFromProbe,
  sessionLivenessVerdict,
} from "./liveness";

describe("authorizesTeardown", () => {
  test("only a positive exit authorizes a teardown", () => {
    expect(authorizesTeardown("exited")).toBe(true);
    expect(authorizesTeardown("live")).toBe(false);
    expect(authorizesTeardown("unverifiable")).toBe(false);
  });

  test("every verdict but exited is safe", () => {
    const authorizing = LIVENESS_VERDICTS.filter(authorizesTeardown);
    expect(authorizing).toEqual(["exited"]);
  });
});

describe("verdictFromProbe", () => {
  test("passes a completed probe's answer through", async () => {
    expect(await verdictFromProbe(async () => "live")).toBe("live");
    expect(await verdictFromProbe(async () => "exited")).toBe("exited");
  });

  test("a probe that throws answers unverifiable, never exited", async () => {
    const verdict = await verdictFromProbe(async () => {
      throw new Error("tmux: connection timed out");
    });
    expect(verdict).toBe("unverifiable");
    expect(authorizesTeardown(verdict)).toBe(false);
  });
});

describe("confineToOwningDevice", () => {
  test("another device's exit claim degrades to unverifiable", () => {
    expect(confineToOwningDevice("exited", false)).toBe("unverifiable");
    expect(confineToOwningDevice("exited", true)).toBe("exited");
  });

  test("contact travels; only the exit claim is confined", () => {
    expect(confineToOwningDevice("live", false)).toBe("live");
    expect(confineToOwningDevice("unverifiable", true)).toBe("unverifiable");
  });
});

describe("sessionLivenessVerdict", () => {
  test("a heartbeat is contact", () => {
    expect(sessionLivenessVerdict({ is_live: true, agent_status: "working" })).toBe("live");
  });

  test("a retired row was torn down, which we watched", () => {
    expect(sessionLivenessVerdict({ is_live: false, is_killed: true, agent_status: "working" })).toBe("exited");
  });

  test("mid-work with no heartbeat behind it is unverifiable", () => {
    expect(sessionLivenessVerdict({ is_live: false, agent_status: "working" })).toBe("unverifiable");
  });

  test("a settled status is the agent's own report that it stopped", () => {
    expect(sessionLivenessVerdict({ is_live: false, agent_status: "idle" })).toBe("exited");
    expect(sessionLivenessVerdict({ is_live: false })).toBe("exited");
  });
});
