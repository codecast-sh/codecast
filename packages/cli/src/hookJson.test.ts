import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOOK_FIELDS_READ } from "./hookJson.js";

const dir = import.meta.dir;
const importers = [
  "statusHook.ts",
  "sessionRegisterHook.ts",
  "threadStateHook.ts",
  "taskPulseHook.ts",
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
});
