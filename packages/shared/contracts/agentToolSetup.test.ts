import { describe, expect, test } from "bun:test";
import { agentSetupMarker, extractAgentSetup, hasAgentSetupMarker } from "./agentToolSetup";

describe("agent setup marker", () => {
  test("a marker line names the tool and leaves the output", () => {
    const out = `✗ the extension has not been paired\n  retry later\n${agentSetupMarker("browser")}\n`;
    expect(hasAgentSetupMarker(out)).toBe(true);
    expect(extractAgentSetup(out)).toEqual({ tool: "browser", text: "✗ the extension has not been paired\n  retry later" });
  });

  test("an indented marker (a batch step's output) still counts", () => {
    expect(extractAgentSetup(`✗ get-app-state\n    ${agentSetupMarker("computer")}`).tool).toBe("computer");
  });

  test("a marker quoted mid-line or naming an unknown tool is not a card", () => {
    expect(extractAgentSetup(`see ${agentSetupMarker("browser")} here`).tool).toBeNull();
    expect(extractAgentSetup("⁢cast:setup printer⁢").tool).toBeNull();
  });

  test("plain output is returned untouched", () => {
    expect(extractAgentSetup("ok\n")).toEqual({ tool: null, text: "ok\n" });
  });
});
