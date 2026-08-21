import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLAUDE_VERSIONED_BINARY_RE, stableClaudeBinary } from "./stableClaudeBinary.js";

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-claude-"));
  const versions = path.join(root, "share", "claude", "versions");
  fs.mkdirSync(versions, { recursive: true });
  const release = (v: string, body = `release ${v}`) => {
    const p = path.join(versions, v);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const dir = path.join(root, ".codecast", "bin");
  return { root, release, dir };
}

describe("stableClaudeBinary", () => {
  test("recognises the native installer's versioned path", () => {
    expect(CLAUDE_VERSIONED_BINARY_RE.test("/Users/u/.local/share/claude/versions/2.1.241")).toBe(true);
    expect(CLAUDE_VERSIONED_BINARY_RE.test("/opt/homebrew/bin/claude")).toBe(false);
    expect(CLAUDE_VERSIONED_BINARY_RE.test("/Users/u/.local/share/claude/versions/2.1.241/bin")).toBe(false);
  });

  test("does nothing off macOS or for an install whose path is already stable", () => {
    const { release, dir } = rig();
    const source = release("2.1.241");
    expect(stableClaudeBinary({ platform: "linux", resolveClaude: () => source, dir })).toBeNull();
    expect(stableClaudeBinary({ platform: "darwin", resolveClaude: () => "/opt/homebrew/bin/claude", dir })).toBeNull();
    expect(stableClaudeBinary({ platform: "darwin", resolveClaude: () => null, dir })).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("copies the release to the fixed path once and reuses it", () => {
    const { release, dir } = rig();
    const source = release("2.1.241");
    const copy = stableClaudeBinary({ platform: "darwin", resolveClaude: () => source, dir });
    expect(copy).toBe(path.join(dir, "claude"));
    expect(fs.readFileSync(copy!, "utf-8")).toBe("release 2.1.241");
    expect(fs.statSync(copy!).mode & 0o111).toBe(0o111);
    const ino = fs.statSync(copy!).ino;
    expect(stableClaudeBinary({ platform: "darwin", resolveClaude: () => source, dir })).toBe(copy);
    expect(fs.statSync(copy!).ino).toBe(ino);
  });

  test("refreshes the copy when the installer moves to a new release", () => {
    const { release, dir } = rig();
    const old = release("2.1.240");
    const copy = stableClaudeBinary({ platform: "darwin", resolveClaude: () => old, dir })!;
    const ino = fs.statSync(copy).ino;
    const next = release("2.1.241");
    expect(stableClaudeBinary({ platform: "darwin", resolveClaude: () => next, dir })).toBe(copy);
    expect(fs.readFileSync(copy, "utf-8")).toBe("release 2.1.241");
    expect(fs.statSync(copy).ino).not.toBe(ino);
  });

  test("refreshes a truncated copy even when the stamp matches", () => {
    const { release, dir } = rig();
    const source = release("2.1.241", "a long enough release body");
    const copy = stableClaudeBinary({ platform: "darwin", resolveClaude: () => source, dir })!;
    fs.writeFileSync(copy, "short");
    expect(stableClaudeBinary({ platform: "darwin", resolveClaude: () => source, dir })).toBe(copy);
    expect(fs.readFileSync(copy, "utf-8")).toBe("a long enough release body");
  });

  test("falls back to the installer's path (null) and warns when the copy fails", () => {
    const { release, dir } = rig();
    const source = release("2.1.241");
    fs.rmSync(source);
    const warnings: string[] = [];
    expect(stableClaudeBinary({ platform: "darwin", resolveClaude: () => source, dir, warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(source);
  });
});
