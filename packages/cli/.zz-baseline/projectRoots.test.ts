import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { enumerateAgentHomeDirs, enumerateProjectRoots } from "./projectRoots";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "projectRoots-"));
}

describe("enumerateAgentHomeDirs", () => {
  test("reports existing agent dirs, skips missing ones", () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".codex"));
    expect(enumerateAgentHomeDirs(home).sort()).toEqual(
      [path.join(home, ".claude"), path.join(home, ".codex")].map((p) => fs.realpathSync(p)).sort(),
    );
  });

  test("resolves symlinks to their target and dedupes", () => {
    const home = tmpHome();
    const target = path.join(home, "dotfiles", "claude");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(home, ".claude"));
    fs.symlinkSync(target, path.join(home, ".codex"));
    expect(enumerateAgentHomeDirs(home)).toEqual([fs.realpathSync(target)]);
  });

  test("agent dirs stay out of the project-root scan (vault registry shares it)", () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, "code", "app"), { recursive: true });
    expect(enumerateProjectRoots(home)).toEqual([path.join(home, "code", "app")]);
  });
});
