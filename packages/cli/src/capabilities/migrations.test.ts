import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runMigrations, skillCopiesToSharedLinks } from "./migrations.js";

const dirs: string[] = [];
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mig-"));
  dirs.push(h);
  return h;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function legacySkill(h: string, client: string, name: string, body = "ship it\n"): string {
  const dir = path.join(h, client, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n${body}`);
  return dir;
}

describe("skill-copies-to-shared-links", () => {
  test("moves a legacy copy to the shared dir and links back", () => {
    const h = home();
    const legacy = legacySkill(h, ".claude", "deploy");
    expect(skillCopiesToSharedLinks.applies(h)).toBe(true);

    const [report] = runMigrations(h, () => {});
    expect(report!.moved).toHaveLength(1);
    // Content moved, link back in place, nothing lost.
    const shared = path.join(h, ".agents", "skills", "deploy");
    expect(fs.existsSync(path.join(shared, "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(legacy, "SKILL.md"), "utf-8")).toContain("ship it");
  });

  test("idempotent: a second run finds nothing to do", () => {
    const h = home();
    legacySkill(h, ".claude", "deploy");
    runMigrations(h, () => {});
    expect(skillCopiesToSharedLinks.applies(h)).toBe(false);
    expect(runMigrations(h, () => {})).toHaveLength(0);
  });

  test("identical copies in two clients collapse to one shared dir, two links", () => {
    const h = home();
    legacySkill(h, ".claude", "deploy");
    legacySkill(h, ".cursor", "deploy");
    const [report] = runMigrations(h, () => {});
    expect(report!.moved).toHaveLength(2);
    for (const client of [".claude", ".cursor"]) {
      expect(fs.lstatSync(path.join(h, client, "skills", "deploy")).isSymbolicLink()).toBe(true);
    }
  });

  test("a DIFFERING legacy copy is left in place and reported, never deleted", () => {
    const h = home();
    legacySkill(h, ".claude", "deploy", "version A\n");
    fs.mkdirSync(path.join(h, ".agents", "skills", "deploy"), { recursive: true });
    fs.writeFileSync(
      path.join(h, ".agents", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\n---\nversion B\n",
    );
    const [report] = runMigrations(h, () => {});
    expect(report!.skipped).toHaveLength(1);
    expect(report!.skipped[0]).toContain("differs");
    // Both versions still exist — a migration must not resolve a conflict by
    // deletion.
    expect(fs.readFileSync(path.join(h, ".claude", "skills", "deploy", "SKILL.md"), "utf-8")).toContain("version A");
    expect(fs.readFileSync(path.join(h, ".agents", "skills", "deploy", "SKILL.md"), "utf-8")).toContain("version B");
  });

  test("non-skill directories and existing links are untouched", () => {
    const h = home();
    const notSkill = path.join(h, ".claude", "skills", "just-a-dir");
    fs.mkdirSync(notSkill, { recursive: true });
    fs.writeFileSync(path.join(notSkill, "notes.txt"), "no SKILL.md here");
    expect(skillCopiesToSharedLinks.applies(h)).toBe(false);
    runMigrations(h, () => {});
    expect(fs.readFileSync(path.join(notSkill, "notes.txt"), "utf-8")).toBe("no SKILL.md here");
  });
});
