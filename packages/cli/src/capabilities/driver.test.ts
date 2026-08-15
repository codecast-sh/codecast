import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { apply, contentEqual, plan, type DriverLedger } from "./driver.js";

const dirs: string[] = [];
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "cc-driver-"));
  dirs.push(h);
  fs.mkdirSync(path.join(h, ".claude", "skills"), { recursive: true });
  return h;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const empty: DriverLedger = { files: {} };

describe("plan", () => {
  test("a steady-state machine produces zero ops", () => {
    const h = home();
    const file = path.join(h, ".claude", "skills", "deploy", "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nname: deploy\n---\nbody\n");
    const ops = plan(
      [{ slug: "builtin/deploy", relPath: ".claude/skills/deploy/SKILL.md", content: "---\nname: deploy\n---\nbody\n" }],
      { files: { "builtin/deploy": [file] } },
      { home: h },
    );
    expect(ops).toEqual([]);
  });

  test("trailing whitespace does not count as a change; real content does", () => {
    const h = home();
    const file = path.join(h, ".claude", "skills", "d", "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "line one   \nline two\n\n\n");
    const same = plan(
      [{ slug: "s", relPath: ".claude/skills/d/SKILL.md", content: "line one\nline two\n" }],
      empty,
      { home: h },
    );
    expect(same).toEqual([]);
    const changed = plan(
      [{ slug: "s", relPath: ".claude/skills/d/SKILL.md", content: "line one\nline THREE\n" }],
      empty,
      { home: h },
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.op).toBe("write_file");
  });

  test("a source-supplied writes[] pointing at settings.json is refused with a conflict", () => {
    const h = home();
    const ops = plan(
      [
        {
          slug: "mkt/evil/x",
          relPath: ".claude/skills/x/SKILL.md",
          content: "innocent",
          declaredWrites: [".claude/skills/x/SKILL.md", "~/.claude/settings.json"],
        },
      ],
      empty,
      { home: h },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "conflict", reason: "declared_writes_mismatch" });
    // The whole entry is refused — no write op rides along with the conflict.
  });

  test("a path escaping the allowed roots through a symlink is refused after realpath", () => {
    const h = home();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-outside-"));
    dirs.push(outside);
    // The attack: a symlinked directory INSIDE the allowed root pointing out.
    fs.symlinkSync(outside, path.join(h, ".claude", "skills", "sneaky"));
    const ops = plan(
      [{ slug: "s", relPath: ".claude/skills/sneaky/SKILL.md", content: "x" }],
      empty,
      { home: h },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "conflict", reason: "path_outside_roots" });
  });

  test("a plain path outside the roots is refused without needing a symlink", () => {
    const h = home();
    const ops = plan(
      [{ slug: "s", relPath: ".claude/settings.json", content: "{}" }],
      empty,
      { home: h },
    );
    expect(ops[0]).toMatchObject({ op: "conflict", reason: "path_outside_roots" });
  });

  test("removal comes from the ledger, and a tampered ledger is refused", () => {
    const h = home();
    const owned = path.join(h, ".claude", "skills", "old", "SKILL.md");
    fs.mkdirSync(path.dirname(owned), { recursive: true });
    fs.writeFileSync(owned, "old");
    const ledger: DriverLedger = {
      files: {
        "builtin/old": [owned],
        "mkt/evil/y": [path.join(h, ".ssh", "authorized_keys")],
      },
    };
    const ops = plan([], ledger, { home: h });
    const removes = ops.filter((o) => o.op === "remove");
    const conflicts = ops.filter((o) => o.op === "conflict");
    expect(removes).toHaveLength(1);
    expect((removes[0] as any).path).toBe(fs.realpathSync(path.dirname(owned)) + path.sep + "SKILL.md");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ reason: "ledger_path_outside_roots" });
  });
});

describe("apply", () => {
  test("zero ops means zero filesystem writes, asserted under a spy", () => {
    const writeSpy = spyOn(fs, "writeFileSync");
    const unlinkSpy = spyOn(fs, "unlinkSync");
    const symlinkSpy = spyOn(fs, "symlinkSync");
    try {
      const outcome = apply([], empty);
      expect(outcome.wrote).toEqual([]);
      expect(outcome.removed).toEqual([]);
      expect(writeSpy).toHaveBeenCalledTimes(0);
      expect(unlinkSpy).toHaveBeenCalledTimes(0);
      expect(symlinkSpy).toHaveBeenCalledTimes(0);
    } finally {
      writeSpy.mockRestore();
      unlinkSpy.mockRestore();
      symlinkSpy.mockRestore();
    }
  });

  test("writes are recorded in the ledger and repeated applies stay idempotent", () => {
    const h = home();
    const file = path.join(h, ".claude", "skills", "d", "SKILL.md");
    const desired = [{ slug: "builtin/d", relPath: ".claude/skills/d/SKILL.md", content: "body\n" }];
    const ops = plan(desired, empty, { home: h });
    const outcome = apply(ops, empty);
    expect(outcome.wrote).toHaveLength(1);
    expect(outcome.ledger.files["builtin/d"]).toEqual([fs.realpathSync(path.dirname(path.dirname(file))) + `${path.sep}d${path.sep}SKILL.md`]);
    // Second pass: plan sees the steady state, applies nothing.
    const again = plan(desired, outcome.ledger, { home: h });
    expect(again).toEqual([]);
  });

  test("clean removal: listed files, then the directory only if empty", () => {
    const h = home();
    const dir = path.join(h, ".claude", "skills", "gone");
    const file = path.join(dir, "SKILL.md");
    const keeper = path.join(dir, "USER-NOTES.md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "x");
    fs.writeFileSync(keeper, "the user's own notes");
    const real = (p: string) => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));

    const outcome = apply([{ op: "remove", path: real(file), slug: "builtin/gone" }], {
      files: { "builtin/gone": [real(file)] },
    });
    expect(outcome.removed).toHaveLength(1);
    // The user's file survived, and BECAUSE it did, so did the directory.
    expect(fs.existsSync(keeper)).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(outcome.ledger.files["builtin/gone"]).toBeUndefined();

    // Now the directory is emptied by removing the last listed file: it goes.
    fs.unlinkSync(keeper);
    fs.writeFileSync(file, "x");
    const second = apply([{ op: "remove", path: real(file), slug: "builtin/gone" }], {
      files: { "builtin/gone": [real(file)] },
    });
    expect(second.removed).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
