import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeDefaultAlias, planClaudeSettingsModel, reconcileClaudeSettingsModel } from "./claudeDefaultModel.js";

describe("planClaudeSettingsModel", () => {
  test("rewrites a drifted model and keeps everything else", () => {
    const out = planClaudeSettingsModel('{\n  "model": "haiku",\n  "hooks": { "SessionStart": [] }\n}', "fable");
    expect(JSON.parse(out!)).toEqual({ model: "fable", hooks: { SessionStart: [] } });
  });

  test("adds the key when the file has none", () => {
    expect(JSON.parse(planClaudeSettingsModel("{}", "opus")!)).toEqual({ model: "opus" });
  });

  test("is a no-op when already in sync, with no default, or on junk", () => {
    expect(planClaudeSettingsModel('{"model":"fable"}', "fable")).toBeNull();
    expect(planClaudeSettingsModel('{"model":"haiku"}', undefined)).toBeNull();
    expect(planClaudeSettingsModel("not json", "fable")).toBeNull();
    expect(planClaudeSettingsModel(null, "fable")).toBeNull();
    expect(planClaudeSettingsModel("[1]", "fable")).toBeNull();
  });
});

describe("claudeDefaultAlias", () => {
  test("maps the codecast default key to the settings alias", () => {
    expect(claudeDefaultAlias({ claude: "opus" })).toBe("opus");
    expect(claudeDefaultAlias({ claude: "fable", codex: "gpt-5.5" })).toBe("fable");
  });
  test("unset, default, or unknown keys leave the file alone", () => {
    expect(claudeDefaultAlias(undefined)).toBeUndefined();
    expect(claudeDefaultAlias({})).toBeUndefined();
    expect(claudeDefaultAlias({ claude: "default" })).toBeUndefined();
    expect(claudeDefaultAlias({ claude: "menu:Nope" })).toBeUndefined();
  });
});

describe("reconcileClaudeSettingsModel", () => {
  test("writes only when the file exists and drifted", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cdm-"));
    // No file: nothing to do.
    expect(reconcileClaudeSettingsModel({ claude: "fable" }, home)).toBe(false);
    fs.mkdirSync(path.join(home, ".claude"));
    const file = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "haiku", theme: "dark" }, null, 2));
    expect(reconcileClaudeSettingsModel({ claude: "fable" }, home)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ model: "fable", theme: "dark" });
    // Second pass: already in sync.
    expect(reconcileClaudeSettingsModel({ claude: "fable" }, home)).toBe(false);
  });
});
