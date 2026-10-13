import { describe, expect, test } from "bun:test";
import { parseAgentToolSetupArgs, runAgentToolSetup } from "./agentToolSetup.js";

const ran = (stdout: string, code = 0, stderr = "") => async () => ({ code, stdout, stderr });

describe("agent_tool_setup", () => {
  test("args need a known tool and op", () => {
    expect(parseAgentToolSetupArgs(JSON.stringify({ tool: "browser", op: "check", conversation_id: "c" }))).toEqual({ tool: "browser", op: "check" });
    expect(parseAgentToolSetupArgs(JSON.stringify({ tool: "printer", op: "check" }))).toBeNull();
    expect(parseAgentToolSetupArgs("{nope")).toBeNull();
  });

  test("browser check reads the status json", async () => {
    const status = await runAgentToolSetup({ tool: "browser", op: "check" }, { runCast: ran('{"paired":true,"connected":false,"chrome_running":true}') });
    expect(status).toEqual({ tool: "browser", ready: false, paired: true, connected: false, chrome_running: true });
  });

  test("a check that prints nothing parseable reports why", async () => {
    const status = await runAgentToolSetup({ tool: "browser", op: "check" }, { runCast: ran("", 1, "error: unknown option '--json'\n") });
    expect(status).toMatchObject({ ready: false, detail: "error: unknown option '--json'" });
  });

  test("computer check maps both grants from pretty-printed json", async () => {
    const json = JSON.stringify({ platform: "darwin", helperUnavailableReason: null, permissions: [{ id: "accessibility", status: "granted" }, { id: "screenshots", status: "not-granted" }] }, null, 2);
    const status = await runAgentToolSetup({ tool: "computer", op: "check" }, { runCast: ran(json) });
    expect(status).toEqual({ tool: "computer", ready: false, accessibility: true, screen_recording: false, supported: true });
  });

  test("computer off macOS and Linux is unsupported", async () => {
    const json = JSON.stringify({ platform: "win32", helperUnavailableReason: null, permissions: [{ id: "accessibility", status: "unsupported" }, { id: "screenshots", status: "unsupported" }] });
    const status = await runAgentToolSetup({ tool: "computer", op: "check" }, { runCast: ran(json) });
    expect(status).toMatchObject({ ready: false, supported: false, detail: "cast computer does not run on win32" });
  });

  test("start runs the CLI's own setup verb", async () => {
    const started: string[][] = [];
    const startCast = (a: string[]) => { started.push(a); return undefined; };
    await runAgentToolSetup({ tool: "computer", op: "start" }, { runCast: ran(""), startCast });
    await runAgentToolSetup({ tool: "browser", op: "start" }, { runCast: ran(""), startCast });
    expect(started).toEqual([["computer", "setup", "--yes"], ["browser", "extension", "setup"]]);
  });
});

describe("computer grant failures", () => {
  test("a missing grant puts the card under the failure; a peer failure does not", async () => {
    const { ComputerError, grantSetupLines } = await import("./computer/errors.js");
    const denied = grantSetupLines(new ComputerError("permission_denied", "Accessibility permission is required. Run …"));
    expect(denied[1]).toContain("cast:setup computer");
    expect(grantSetupLines(new ComputerError("permission_denied", "computer agent peer is not the helper"))).toEqual([]);
    expect(grantSetupLines(new ComputerError("element_not_found", "Accessibility tree has no element 4"))).toEqual([]);
  });
});
