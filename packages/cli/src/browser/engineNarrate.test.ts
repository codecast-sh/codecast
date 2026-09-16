import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runEngine } from "./engine";
import { engineStepLabel } from "./cliEngine";

// A stand-in engine: prints its arguments after a pause, so both the
// synchronous and the narrated run see the same process.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-engine-"));
const fake = path.join(dir, "agent-browser");
fs.writeFileSync(fake, `#!/bin/sh\nsleep 0.2\necho "ran $1 $2"\necho "noted" >&2\nexit 3\n`);
fs.chmodSync(fake, 0o755);
const before = process.env.CAST_BROWSER_ENGINE;
process.env.CAST_BROWSER_ENGINE = fake;

afterEach(() => {
  if (before === undefined) delete process.env.CAST_BROWSER_ENGINE;
  else process.env.CAST_BROWSER_ENGINE = before;
  process.env.CAST_BROWSER_ENGINE = fake;
});

describe("runEngine", () => {
  test("silent by default: synchronous, and the run is the process's exit, stdout and stderr", () => {
    const res = runEngine(["open", "https://example.com"], { cdp: "ws://127.0.0.1:1/x", session: "t" });
    expect(res.status).toBe(3);
    expect(res.stdout).toStartWith("ran open https://example.com");
    expect(res.stderr).toBe("noted\n");
  });

  test("narrated: asynchronous, same process, same run", async () => {
    const pending = runEngine(["open", "https://example.com"], { cdp: "ws://127.0.0.1:1/x", session: "t", narrate: "opening the page" });
    expect(pending).toBeInstanceOf(Promise);
    const res = await pending;
    expect(res.status).toBe(3);
    expect(res.stdout).toStartWith("ran open https://example.com");
    expect(res.stderr).toBe("noted\n");
  });
});

describe("engineStepLabel", () => {
  test("open names the URL and the steps it covers", () => {
    expect(engineStepLabel("open", ["open", "https://www.google.com", "--pin-tab"])).toBe("opening https://www.google.com in Chrome (attach, navigate, load)");
    expect(engineStepLabel("open", ["tab", "new", "https://x.test"])).toBe("opening https://x.test in Chrome (attach, navigate, load)");
  });
  test("other verbs name the verb", () => {
    expect(engineStepLabel("snapshot", ["snapshot", "-i"])).toBe("waiting for the browser to finish `snapshot`");
  });
});
