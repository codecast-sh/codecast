// A published extractor or judge stays readable by its version id outside the
// product's checkout (publishedSources.ts): the version is the file's git blob
// hash, so the kept copy is that very object.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { archivePublished } from "./publishedSources";

const blob = (file: string) => spawnSync("git", ["hash-object", file], { encoding: "utf8" }).stdout.trim();

describe("archivePublished", () => {
  test("keeps each version under its own id, commits only what changed, and refuses a mismatched version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pubsrc-root-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pubsrc-home-"));
    fs.mkdirSync(path.join(root, ".codecast/judges"), { recursive: true });
    const judge = ".codecast/judges/comms.md";
    fs.writeFileSync(path.join(root, judge), "first words\n");
    const v1 = blob(path.join(root, judge));
    const first = archivePublished(root, "union-moments", [{ path: judge, version: v1 }], dir);
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(archivePublished(root, "union-moments", [{ path: judge, version: v1 }], dir).commit).toBeNull();

    fs.writeFileSync(path.join(root, judge), "second words\n");
    const v2 = blob(path.join(root, judge));
    expect(archivePublished(root, "union-moments", [{ path: judge, version: v2 }], dir).commit).not.toBeNull();
    // The checkout loses the file; both versions still read back by id.
    fs.rmSync(root, { recursive: true, force: true });
    const cat = (v: string) => spawnSync("git", ["-C", dir, "cat-file", "-p", v], { encoding: "utf8" }).stdout;
    expect(cat(v1)).toBe("first words\n");
    expect(cat(v2)).toBe("second words\n");

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "pubsrc-root-"));
    fs.mkdirSync(path.join(other, ".codecast/judges"), { recursive: true });
    fs.writeFileSync(path.join(other, judge), "third\n");
    expect(() => archivePublished(other, "union-moments", [{ path: judge, version: v1 }], dir)).toThrow(/not the published/);
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
