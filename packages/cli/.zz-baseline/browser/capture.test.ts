/**
 * Failure-capture rules: which failures deserve page context, and how the
 * block stays bounded. These are the decisions that make the feature safe to
 * run on every failure — a capture that hangs, floods the thread, or fires on
 * a typo would be worse than no capture at all.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CAPTURE_MAX_CONSOLE,
  CAPTURE_MAX_LINE,
  CAPTURE_MAX_NETWORK,
  captureConfigOff,
  classifyFailure,
  formatFailureContext,
} from "./capture.js";
import type { Recording } from "./observe.js";

const emptyRecording = (over: Partial<Recording> = {}): Recording => ({
  console: [],
  network: [],
  errors: [],
  armed: true,
  late: false,
  dialogs: [],
  ...over,
});

describe("classifyFailure", () => {
  test("page-state failures are capturable", () => {
    expect(classifyFailure(`"Loaded" never appeared within 15000ms`)).toBe("capturable");
    expect(classifyFailure("#e42 never appeared within 15000ms")).toBe("capturable");
    expect(classifyFailure("ReferenceError: foo is not defined")).toBe("capturable");
    expect(classifyFailure("element #e7 is covered by another element")).toBe("capturable");
    expect(classifyFailure("Runtime.evaluate did not answer within 30000ms")).toBe("capturable");
  });

  test("a wedged tab is recognised from TabUnresponsive's message", () => {
    expect(classifyFailure("tab ab12cd34 did not respond (Page.enable did not answer within 15000ms).")).toBe(
      "tab-wedged",
    );
  });

  test("a dead browser or connection is not capturable", () => {
    expect(classifyFailure("CDP connection closed")).toBe("browser-gone");
    expect(classifyFailure("CDP connection is not open (Runtime.evaluate)")).toBe("browser-gone");
    expect(classifyFailure("no managed browser is running")).toBe("browser-gone");
    expect(
      classifyFailure("the managed browser (pid 123) is not answering CDP right now"),
    ).toBe("browser-gone");
    expect(classifyFailure("CDP connection closed — the browser was stopped or restarted (usually by another agent) mid-command. Run the command again.")).toBe("browser-gone");
  });

  test("usage errors get no page context", () => {
    expect(classifyFailure("'foo' is not a ref — refs look like #e1234 and come from `cast browser snapshot`")).toBe(
      "usage",
    );
    expect(classifyFailure("click needs a ref, or a `find` before it")).toBe("usage");
    expect(classifyFailure("open needs a url")).toBe("usage");
    expect(classifyFailure("unknown step 'frobnicate'")).toBe("usage");
  });

  test("the engine's argument errors get no page context either", () => {
    // `cast browser skills core` (the wrong form) used to screenshot the page.
    expect(classifyFailure("Unknown skills subcommand: core")).toBe("usage");
    expect(classifyFailure("Unknown command: frobnicate")).toBe("usage");
    expect(classifyFailure("Skill not found: bogus")).toBe("usage");
    expect(classifyFailure("Missing arguments for: get")).toBe("usage");
    expect(classifyFailure("Usage: agent-browser click <selector> [--new-tab]")).toBe("usage");
    expect(classifyFailure("Invalid read URL: invalid international domain name")).toBe("usage");
    expect(classifyFailure("Unexpected read argument: [role=main]")).toBe("usage");
  });

  test("engine failures that asked the page keep their context", () => {
    expect(classifyFailure("Unknown ref: e99999")).toBe("capturable");
    expect(classifyFailure("Wait timed out after 1000ms")).toBe("capturable");
  });
});

describe("formatFailureContext", () => {
  test("empty recording reports the absence rather than printing nothing", () => {
    const out = formatFailureContext(emptyRecording());
    expect(out.hasSignal).toBe(false);
    expect(out.lines.join("\n")).toContain("no console errors or failed requests");
  });

  test("an unarmed recorder is reported honestly", () => {
    const out = formatFailureContext(emptyRecording({ armed: false }));
    expect(out.hasSignal).toBe(false);
    expect(out.lines.join("\n")).toContain("recorder was not installed");
  });

  test("only errors and warnings survive; info noise does not", () => {
    const out = formatFailureContext(
      emptyRecording({
        console: [
          { t: 1000, level: "log", text: "boot ok" },
          { t: 2000, level: "info", text: "sync tick" },
          { t: 3000, level: "error", text: "boom" },
          { t: 4000, level: "warn", text: "wobbly" },
        ],
      }),
    );
    const text = out.lines.join("\n");
    expect(out.hasSignal).toBe(true);
    expect(text).toContain("boom");
    expect(text).toContain("wobbly");
    expect(text).not.toContain("boot ok");
    expect(text).not.toContain("sync tick");
  });

  test("uncaught page errors are included alongside console errors, newest first", () => {
    const out = formatFailureContext(
      emptyRecording({
        console: [{ t: 1000, level: "error", text: "older console error" }],
        errors: [{ t: 5000, text: "TypeError: newest uncaught", stack: null }],
      }),
    );
    const text = out.lines.join("\n");
    expect(text).toContain("UNCAUGHT TypeError: newest uncaught");
    expect(text.indexOf("newest uncaught")).toBeLessThan(text.indexOf("older console error"));
  });

  test("console entries are capped with a count of what was dropped", () => {
    const out = formatFailureContext(
      emptyRecording({
        console: Array.from({ length: 30 }, (_, i) => ({ t: i * 100, level: "error", text: `err ${i}` })),
      }),
    );
    const entryLines = out.lines.filter((l) => / ERR /.test(l));
    expect(entryLines.length).toBe(CAPTURE_MAX_CONSOLE);
    // Newest first: the highest-numbered error leads.
    expect(entryLines[0]).toContain("err 29");
    expect(out.lines.join("\n")).toContain(`… ${30 - CAPTURE_MAX_CONSOLE} more`);
  });

  test("only failed requests appear, capped, newest first", () => {
    const network = [
      ...Array.from({ length: 20 }, (_, i) => ({
        t: i * 100, ms: 5, method: "GET", url: `https://ok/${i}`, status: 200, kind: "fetch",
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        t: 10_000 + i * 100, ms: 5, method: "GET", url: `https://bad/${i}`, status: 500, kind: "fetch",
      })),
      { t: 99_000, ms: 5, method: "POST", url: "https://dead/api", status: 0, kind: "fetch", error: "net::ERR_FAILED" },
    ];
    const out = formatFailureContext(emptyRecording({ network }));
    const rows = out.lines.filter((l) => /https:\/\//.test(l));
    expect(rows.length).toBe(CAPTURE_MAX_NETWORK);
    expect(rows[0]).toContain("https://dead/api");
    expect(rows[0]).toContain("net::ERR_FAILED");
    expect(out.lines.join("\n")).not.toContain("https://ok/");
    expect(out.lines.join("\n")).toContain(`… ${11 - CAPTURE_MAX_NETWORK} more`);
  });

  test("a 404 shows its status while a transport failure shows ERR", () => {
    const out = formatFailureContext(
      emptyRecording({
        network: [
          { t: 1, ms: 3, method: "GET", url: "https://x/missing", status: 404, kind: "fetch" },
          { t: 2, ms: 3, method: "GET", url: "https://x/refused", status: 0, kind: "fetch", error: "net::ERR_CONNECTION_REFUSED" },
        ],
      }),
    );
    const text = out.lines.join("\n");
    expect(text).toContain("404");
    expect(text).toContain("ERR");
  });

  test("a stack inside an entry collapses to one line", () => {
    const out = formatFailureContext(
      emptyRecording({
        network: [{
          t: 1, ms: 3, method: "GET", url: "https://x/dead", status: 0, kind: "fetch",
          error: "TypeError: Failed to fetch\n    at window.fetch (<anonymous>:45:37)\n    at http://x/:9:3",
        }],
      }),
    );
    const row = out.lines.find((l) => l.includes("https://x/dead"))!;
    expect(row).not.toContain("\n");
    expect(row).toContain("Failed to fetch");
    expect(row).toContain("at window.fetch");
  });

  test("long lines are clipped so one giant log entry cannot flood the block", () => {
    const out = formatFailureContext(
      emptyRecording({ console: [{ t: 1000, level: "error", text: "x".repeat(5000) }] }),
    );
    for (const line of out.lines) expect(line.length).toBeLessThanOrEqual(CAPTURE_MAX_LINE + 10);
  });
});

describe("captureConfigOff", () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cast-capture-test-"));

  test("off only when the config says off", () => {
    const dir = tmp();
    expect(captureConfigOff(dir)).toBe(false); // no config file
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ browser_capture: "on" }));
    expect(captureConfigOff(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ browser_capture: "off" }));
    expect(captureConfigOff(dir)).toBe(true);
  });

  test("a corrupt config file never disables capture", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "config.json"), "{not json");
    expect(captureConfigOff(dir)).toBe(false);
  });
});

describe("engine failure message", () => {
  test("strips the engine's cross glyph and takes the first non-empty line", async () => {
    const { engineFailureMessage } = await import("./cliEngine.js");
    expect(engineFailureMessage("✗ Wait timed out after 800ms\n", "")).toBe("Wait timed out after 800ms");
    expect(engineFailureMessage("", "\n✗ Evaluation error: TypeError: x\n    at <anonymous>")).toBe("Evaluation error: TypeError: x");
    expect(engineFailureMessage("", "")).toBe("the browser engine reported a failure");
  });
});
