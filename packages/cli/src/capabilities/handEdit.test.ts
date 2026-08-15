import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { contentHash, judgeOwnedFile, reconcileOwnedFile } from "./handEdit.js";

const dirs: string[] = [];
function dir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hand-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const write = (p: string, c: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};

describe("judgeOwnedFile — the three-hash compare", () => {
  const OURS = "## Section\nour content\n";
  const NEW = "## Section\nnewer content\n";
  const record = { wroteHash: contentHash(OURS) };

  test("disk matches what we wrote: converge freely", () => {
    expect(judgeOwnedFile(record, OURS, NEW)).toEqual({ action: "write" });
  });

  test("disk already matches desired: zero ops", () => {
    expect(judgeOwnedFile(record, NEW, NEW)).toEqual({ action: "none" });
  });

  test("disk edited by hand: conflict carrying both texts, never a revert", () => {
    const edited = "## Section\nthe user's own words\n";
    const verdict = judgeOwnedFile(record, edited, NEW);
    expect(verdict).toEqual({
      action: "conflict",
      reason: "locally_modified",
      theirs: edited,
      ours: NEW,
    });
  });

  test("no record yet: first install writes", () => {
    expect(judgeOwnedFile(undefined, undefined, NEW)).toEqual({ action: "write" });
  });
});

describe("reconcileOwnedFile — edits survive, deletions are respected", () => {
  test("an edited owned block survives a reconcile and yields exactly one conflict", () => {
    const d = dir();
    const file = path.join(d, "SKILL.md");
    const first = reconcileOwnedFile(file, undefined, "ours v1\n", write);
    expect(fs.readFileSync(file, "utf-8")).toBe("ours v1\n");

    // The user edits by hand.
    fs.writeFileSync(file, "MY OWN VERSION\n");
    const second = reconcileOwnedFile(file, first.record, "ours v2\n", write);
    // Their copy stays byte-identical; the conflict carries the diff inputs.
    expect(fs.readFileSync(file, "utf-8")).toBe("MY OWN VERSION\n");
    expect(second.conflict).toMatchObject({ reason: "locally_modified" });
    expect(second.conflict!.theirs).toBe("MY OWN VERSION\n");
    expect(second.conflict!.ours).toBe("ours v2\n");

    // The NEXT beat, still edited: still exactly one conflict, still no revert.
    const third = reconcileOwnedFile(file, second.record, "ours v2\n", write);
    expect(fs.readFileSync(file, "utf-8")).toBe("MY OWN VERSION\n");
    expect(third.conflict).toMatchObject({ reason: "locally_modified" });
  });

  test("a deleted owned file is recreated once, then left alone with locally_removed", () => {
    const d = dir();
    const file = path.join(d, "SKILL.md");
    const first = reconcileOwnedFile(file, undefined, "content\n", write);

    fs.unlinkSync(file); // the user deletes it; the parent dir stays
    const second = reconcileOwnedFile(file, first.record, "content\n", write);
    expect(fs.existsSync(file)).toBe(true); // recreated once
    expect(second.record.recreatedOnce).toBe(true);

    fs.unlinkSync(file); // deleted AGAIN: that is a decision
    const third = reconcileOwnedFile(file, second.record, "content\n", write);
    expect(fs.existsSync(file)).toBe(false); // we stopped
    expect(third.record.locallyRemoved).toBe(true);

    // And every later beat holds — no recreation, ever.
    const fourth = reconcileOwnedFile(file, third.record, "content\n", write);
    expect(fs.existsSync(file)).toBe(false);
    expect(fourth.record.locallyRemoved).toBe(true);
  });

  test("a vanished PARENT directory is a moved tree, not a user deletion", () => {
    const d = dir();
    const file = path.join(d, "sub", "SKILL.md");
    const first = reconcileOwnedFile(file, undefined, "content\n", write);
    fs.rmSync(path.dirname(file), { recursive: true });
    // First-install semantics: recreated WITHOUT burning the recreate-once
    // budget, because this was not a targeted deletion of our file.
    const second = reconcileOwnedFile(file, first.record, "content\n", write);
    expect(fs.readFileSync(file, "utf-8")).toBe("content\n");
    expect(second.record.recreatedOnce).toBeUndefined();
  });

  test("a file we never owned is untouched whatever it contains", () => {
    const d = dir();
    const file = path.join(d, "USER.md");
    fs.writeFileSync(file, "not ours at all\n");
    // The caller only reconciles paths it materializes; judge with a record of
    // undefined means first install — so the GUARD is that reconcile is never
    // called for unowned paths. Pin the pure function's contract instead: an
    // edited file with a record is a conflict, not a write, so even a caller
    // bug cannot silently clobber user content that diverged.
    const verdict = judgeOwnedFile({ wroteHash: contentHash("something else") }, "not ours at all\n", "desired\n");
    expect(verdict.action).toBe("conflict");
  });
});
