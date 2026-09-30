import { expect, test, describe } from "bun:test";
import {
  parseUnwrappedSessionReport,
  isUnwrappedSessionReport,
  isMachineDeliveredMessage,
} from "./machineMessages";

describe("parseUnwrappedSessionReport", () => {
  test("a --raw worker report with a task id is attributed, not a human prompt", () => {
    const body =
      "Backend B (ct-51438) review fixes: all five of mine fixed, none skipped.\n\n**Fixed:**\n- Retire leaves the standing markers";
    expect(parseUnwrappedSessionReport(body)).toEqual({
      from: "unknown",
      body,
      name: "Backend B",
    });
    expect(isMachineDeliveredMessage(body)).toBe(true);
  });

  test("a --raw follow-up without a task id still names the worker", () => {
    const body =
      "Backend B follow-up: jx71b14 deployed after levelling the tree. Verified on prod: POST /cli/org/staff now reaches orgRoles.staff.";
    expect(parseUnwrappedSessionReport(body)).toEqual({
      from: "unknown",
      body,
      name: "Backend B",
    });
  });

  test("a wrapped session-message is not this heuristic (the tag parser owns it)", () => {
    expect(
      parseUnwrappedSessionReport('<session-message from="jx76dr3">\nBackend A shipped\n</session-message>'),
    ).toBeNull();
  });

  test("a human prompt is not a worker report", () => {
    expect(isUnwrappedSessionReport("Ok - now what we need to work on is our agentic initialization, and token efficiency.")).toBe(false);
    expect(
      isUnwrappedSessionReport(
        "We want to really be able to mutate with org on page on the side, and have the agent understand and look at how work is flowing.",
      ),
    ).toBe(false);
    expect(
      isUnwrappedSessionReport(
        "Software Factories: Emerging Architectures and Why Frontier Labs Should Care\nSoftware factories are suddenly everywhere.",
      ),
    ).toBe(false);
    expect(isUnwrappedSessionReport("continue")).toBe(false);
    expect(isUnwrappedSessionReport("codecast spike follow-up: what does the README say about setup?")).toBe(false);
    expect(isMachineDeliveredMessage("continue")).toBe(false);
  });
});

describe("a role notice from before the session envelope", () => {
  test("a decision notice and a task hand-off are codecast's, not the host's words", () => {
    for (const body of [
      "decision sd-316 from a session under you: Step 6 of the approved tool cuts?\nRead it with `cast decide show sd-316`.",
      'Ashot Petrosian assigned you ct-1204 "Rank call cards by value"',
    ]) {
      expect(parseUnwrappedSessionReport(body)).toEqual({ from: "unknown", body, name: "codecast" });
      expect(isMachineDeliveredMessage(body)).toBe(true);
    }
  });

  test("a person talking about decisions or assignments is still a person", () => {
    expect(isUnwrappedSessionReport("decision time: which of these should we ship?")).toBe(false);
    expect(isUnwrappedSessionReport("who assigned you that task?")).toBe(false);
  });
});
