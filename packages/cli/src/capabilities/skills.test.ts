import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { materializeSkill } from "./skills.js";

const dirs: string[] = [];
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skills-"));
  dirs.push(h);
  return h;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const FILES = [
  { relPath: "SKILL.md", content: "---\nname: deploy\n---\nship it\n" },
  { relPath: "scripts/run.sh", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
];

describe("materializeSkill", () => {
  test("one content directory plus N links", () => {
    const h = home();
    const claude = path.join(h, ".claude", "skills");
    const cursor = path.join(h, ".cursor", "skills");
    const result = materializeSkill("deploy", FILES, [claude, cursor], h);

    expect(result.wroteFiles).toBe(2);
    expect(fs.readFileSync(path.join(result.contentDir, "SKILL.md"), "utf-8")).toContain("ship it");
    for (const dir of [claude, cursor]) {
      const link = path.join(dir, "deploy");
      expect(result.links[link]).toBe("symlink");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      // The link resolves to the ONE content dir — the no-drift property.
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(result.contentDir));
    }
  });

  test("a second apply is zero writes and leaves correct links alone", () => {
    const h = home();
    const claude = path.join(h, ".claude", "skills");
    materializeSkill("deploy", FILES, [claude], h);
    const linkStat = fs.lstatSync(path.join(claude, "deploy"));
    const again = materializeSkill("deploy", FILES, [claude], h);
    expect(again.wroteFiles).toBe(0);
    // Same inode: the link was not recreated.
    expect(fs.lstatSync(path.join(claude, "deploy")).ino).toBe(linkStat.ino);
  });

  test("a real directory at the link path forces the copy fallback, recorded", () => {
    const h = home();
    const claude = path.join(h, ".claude", "skills");
    const preexisting = path.join(claude, "deploy");
    fs.mkdirSync(preexisting, { recursive: true });
    fs.writeFileSync(path.join(preexisting, "USER-FILE.md"), "the user's own");

    const result = materializeSkill("deploy", FILES, [claude], h);
    expect(result.links[preexisting]).toBe("copy");
    // Still a real directory, user's file intact, our content refreshed in it.
    expect(fs.lstatSync(preexisting).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(preexisting, "USER-FILE.md"), "utf-8")).toBe("the user's own");
    expect(fs.readFileSync(path.join(preexisting, "SKILL.md"), "utf-8")).toContain("ship it");
  });

  test("a stale symlink to an old location is retargeted", () => {
    const h = home();
    const claude = path.join(h, ".claude", "skills");
    fs.mkdirSync(claude, { recursive: true });
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "cc-old-"));
    dirs.push(old);
    fs.symlinkSync(old, path.join(claude, "deploy"));

    const result = materializeSkill("deploy", FILES, [claude], h);
    expect(result.links[path.join(claude, "deploy")]).toBe("symlink");
    expect(fs.realpathSync(path.join(claude, "deploy"))).toBe(fs.realpathSync(result.contentDir));
  });

  test("content updates propagate through the links because there is one copy", () => {
    const h = home();
    const claude = path.join(h, ".claude", "skills");
    materializeSkill("deploy", FILES, [claude], h);
    materializeSkill(
      "deploy",
      [{ relPath: "SKILL.md", content: "---\nname: deploy\n---\nship it v2\n" }],
      [claude],
      h,
    );
    expect(fs.readFileSync(path.join(claude, "deploy", "SKILL.md"), "utf-8")).toContain("v2");
  });
});
