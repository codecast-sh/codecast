// A failed deploy step names its cause on one line (deployCauseLine), and a deploy note's headline is that line.
import { describe, expect, test } from "bun:test";
import { deployCauseLine, deployNoteHeadline } from "./lineDeploy";

// An OTA send that failed on the sending machine's setup: the cause sits under a wall of npm warnings and a stack.
const EAS_LOG = [
  "npm warn deprecated uuid@8.3.2: uuid@10 and below is no longer supported.",
  "npm warn deprecated glob@10.5.0: Old versions of glob are not supported.",
  "Either log in with eas login or set the EXPO_TOKEN environment variable if you're using EAS CLI on CI",
  "    Error: channel:list command failed.",
  "<anonymous_script>:1",
  "An Expo user account is required to proceed.",
  "^",
  "",
  "SyntaxError: Unexpected token 'A', \"An Expo us\"... is not valid JSON",
  "    at JSON.parse (<anonymous>)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)",
  "",
  "Node.js v24.15.0",
  "exited 1",
].join("\n");

describe("deployCauseLine", () => {
  test("a line naming what the step needed wins over warnings, error banners and frames", () => {
    expect(deployCauseLine(EAS_LOG)).toBe("An Expo user account is required to proceed.");
  });

  test("with no need named, the first error line; with none, the last line that is no warning or frame", () => {
    expect(deployCauseLine("building\nnpm warn old\nError: notarize failed for app.dmg\n    at sign (x.js:1:1)\nnpm error code 1\nexited 1")).toBe("Error: notarize failed for app.dmg");
    expect(deployCauseLine("Waiting for the CLI release in flight (runs 12)\nnpm warn x\nexited 1")).toBe("Waiting for the CLI release in flight (runs 12)");
    expect(deployCauseLine("npm warn x\n    at y (z.js:1:1)\nexited 1")).toBeNull();
    expect(deployCauseLine("")).toBeNull();
  });

  test("one line, cut", () => {
    const long = `Error: ${"x".repeat(400)}`;
    const cut = deployCauseLine(long)!;
    expect(cut.length).toBe(240);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("deployNoteHeadline", () => {
  test("a note written before stops named their cause reads 'Stopped at <step>: <cause>'", () => {
    expect(deployNoteHeadline(`Stopped at Send.\n${EAS_LOG}`)).toBe("Stopped at Send: An Expo user account is required to proceed.");
    expect(deployNoteHeadline("Stopped at Send.\nA cut-cli-release.yml run is already in flight: https://github.com/o/r/actions/runs/1\nexited 1")).toBe("Stopped at Send: A cut-cli-release.yml run is already in flight: https://github.com/o/r/actions/runs/1");
  });

  test("a note that names its cause already, or says nothing more, stands as its first line", () => {
    expect(deployNoteHeadline("Stopped at Send: An Expo user account is required to proceed.\nexited 1\n…")).toBe("Stopped at Send: An Expo user account is required to proceed.");
    expect(deployNoteHeadline("Stopped at Live.")).toBe("Stopped at Live.");
    expect(deployNoteHeadline("dp-4 was not live within 90 minutes")).toBe("dp-4 was not live within 90 minutes");
    expect(deployNoteHeadline(null)).toBeNull();
  });
});
