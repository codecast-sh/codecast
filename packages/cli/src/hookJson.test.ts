import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOOK_FIELDS_READ, HOOK_STATE_DIR } from "./hookJson.js";

const dir = import.meta.dir;
const importers = [
  "statusHook.ts",
  "sessionRegisterHook.ts",
  "threadStateHook.ts",
  "taskContextHook.ts",
  "userPromptHook.ts",
];

describe("hookJson export is what the hook modules import", () => {
  test("HOOK_FIELDS_READ is the only name hook modules import from hookJson", () => {
    expect(HOOK_FIELDS_READ).toContain("HOOK_session_id");
    const hookJson = fs.readFileSync(path.join(dir, "hookJson.ts"), "utf-8");
    expect(hookJson).toContain("export const HOOK_FIELDS_READ");
    expect(hookJson).not.toContain("HOOK_JSON_STR_FN");
    for (const file of importers) {
      const src = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(src, file).toContain('from "./hookJson.js"');
      expect(src, file).toContain("HOOK_FIELDS_READ");
      expect(src, file).not.toContain("HOOK_JSON_STR_FN");
    }
  });

  // The scripts these modules build, as installed. Each is its own process, so
  // each carries the parser, feature_on and the state directory at most once.
  test("each installed script carries the parser, feature_on and the state directory once", async () => {
    const { USER_PROMPT_HOOK } = await import("./userPromptHook.js");
    const { THREAD_STATE_HOOK } = await import("./threadStateHook.js");
    const { CODECAST_STATUS_HOOK } = await import("./statusHook.js");
    const { SESSION_REGISTER_HOOK } = await import("./sessionRegisterHook.js");
    const { TASK_CONTEXT_HOOK } = await import("./taskContextHook.js");
    const { CODECAST_STATUSLINE_HOOK } = await import("./statuslineHook.js");
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    const scripts = { USER_PROMPT_HOOK, THREAD_STATE_HOOK, CODECAST_STATUS_HOOK, SESSION_REGISTER_HOOK, TASK_CONTEXT_HOOK, CODECAST_STATUSLINE_HOOK };
    for (const [name, script] of Object.entries(scripts)) {
      expect(count(script, "function envelope_str("), name).toBeLessThanOrEqual(1);
      expect(count(script, "feature_on() {"), name).toBeLessThanOrEqual(1);
      // The one place a script spells the default directory.
      expect(count(script, HOOK_STATE_DIR), name).toBe(1);
      expect(count(script, "$HOME/.codecast"), name).toBe(1);
    }
    expect(count(USER_PROMPT_HOOK, "function envelope_str(")).toBe(1);
    expect(count(USER_PROMPT_HOOK, "feature_on() {")).toBe(1);
  });
});
