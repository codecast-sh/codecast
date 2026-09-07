import { describe, expect, test } from "bun:test";
import { MIRROR_MAGIC, buildMirrorBundle, parseMirrorBundle, type BundleInput } from "./bundle";

const source = { device_id: "dev1", user_id: "u1", home: "/Users/a", platform: "darwin", cast_version: "1.0.0" };
const meta = { source, target_home: "/home/ubuntu", managed_roots: [".claude", ".codex"] };

function entries(): BundleInput[] {
  return [
    { path: ".claude/skills/a/SKILL.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("skill a\n") },
    { path: ".claude/hooks/mine.sh", kind: "verbatim", mode: "0700", bytes: Buffer.from("#!/bin/sh\n") },
    { path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from("# rules\n") },
    { path: ".codex/config.toml", kind: "codex-toml", mode: "0600", bytes: Buffer.alloc(0) },
  ];
}

async function* chunks(buf: Buffer, size = 7): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe("mirror bundle", () => {
  test("build → parse round trip preserves bytes, modes, kinds, in path order", async () => {
    const built = buildMirrorBundle(entries(), meta);
    expect(built.bytes.subarray(0, MIRROR_MAGIC.length).toString()).toBe(MIRROR_MAGIC);
    const parsed = await parseMirrorBundle(chunks(built.bytes));
    expect(parsed.hash).toBe(built.hash);
    expect(parsed.files.map((f) => f.path)).toEqual([".claude/CLAUDE.md", ".claude/hooks/mine.sh", ".claude/skills/a/SKILL.md", ".codex/config.toml"]);
    expect(parsed.files.find((f) => f.path === ".claude/hooks/mine.sh")).toMatchObject({ mode: "0700", kind: "verbatim" });
    expect(parsed.files.find((f) => f.path === ".claude/skills/a/SKILL.md")!.bytes.toString()).toBe("skill a\n");
    expect(parsed.files.find((f) => f.path === ".codex/config.toml")!.bytes.length).toBe(0);
    expect(parsed.header.source).toEqual(source);
    expect(parsed.header.managed_roots).toEqual([".claude", ".codex"]);
  });

  test("the hash ignores entry order, take_over, skipped, scrubbed, excludes and cast_version; a body byte changes it", () => {
    const a = buildMirrorBundle(entries(), meta).hash;
    expect(buildMirrorBundle([...entries()].reverse(), meta).hash).toBe(a);
    expect(buildMirrorBundle(entries(), { ...meta, take_over: true, skipped: [{ path: "x", reason: "y" }], scrubbed: ["k"], excludes_applied: ["g"] }).hash).toBe(a);
    expect(buildMirrorBundle(entries(), { ...meta, source: { ...source, cast_version: "9.9.9" } }).hash).toBe(a);
    const changed = entries();
    changed[0]!.bytes = Buffer.from("skill A\n");
    expect(buildMirrorBundle(changed, meta).hash).not.toBe(a);
    const mode = entries();
    mode[0]!.mode = "0700";
    expect(buildMirrorBundle(mode, meta).hash).not.toBe(a);
  });

  test.each([
    ["truncated body", (b: Buffer) => b.subarray(0, b.length - 3), /truncated/],
    ["trailing bytes", (b: Buffer) => Buffer.concat([b, Buffer.from("x")]), /trailing/],
    ["bad magic", (b: Buffer) => Buffer.concat([Buffer.from("NOPE"), b.subarray(4)]), /bad magic/],
  ])("rejects a %s", async (_name, mutate, re) => {
    const built = buildMirrorBundle(entries(), meta);
    await expect(parseMirrorBundle(mutate(built.bytes))).rejects.toThrow(re);
  });

  function withHeader(mutate: (h: Record<string, unknown>) => void): Buffer {
    const built = buildMirrorBundle(entries(), meta);
    const len = built.bytes.readUInt32BE(MIRROR_MAGIC.length);
    const start = MIRROR_MAGIC.length + 4;
    const header = JSON.parse(built.bytes.subarray(start, start + len).toString());
    mutate(header);
    const hb = Buffer.from(JSON.stringify(header));
    const lb = Buffer.alloc(4);
    lb.writeUInt32BE(hb.length, 0);
    return Buffer.concat([Buffer.from(MIRROR_MAGIC), lb, hb, built.bytes.subarray(start + len)]);
  }

  test.each([
    ["version 3", (h: any) => { h.version = 3; }, /version/],
    ["../x", (h: any) => { h.files[0].path = "../x"; }, /unsafe/],
    [".git/config", (h: any) => { h.files[0].path = ".git/config"; }, /unsafe/],
    ["absolute path", (h: any) => { h.files[0].path = "/etc/passwd"; }, /unsafe/],
    ["backslash", (h: any) => { h.files[0].path = "a\\b"; }, /unsafe/],
    ["size mismatch", (h: any) => { h.files[0].size += 1; }, /sha256 mismatch|truncated/],
    ["sha mismatch", (h: any) => { h.files[0].sha256 = "0".repeat(64); }, /sha256 mismatch/],
    ["unknown kind", (h: any) => { h.files[0].kind = "tarball"; }, /unknown mirror kind/],
    ["bad mode", (h: any) => { h.files[0].mode = "0644"; }, /bad mode/],
    ["duplicate path", (h: any) => { h.files[1].path = h.files[0].path; }, /duplicate/],
  ])("rejects %s before any write", async (_name, mutate, re) => {
    await expect(parseMirrorBundle(withHeader(mutate))).rejects.toThrow(re);
  });

  test("an empty bundle is valid", async () => {
    const built = buildMirrorBundle([], meta);
    const parsed = await parseMirrorBundle(built.bytes);
    expect(parsed.files).toEqual([]);
    expect(parsed.hash).toBe(built.hash);
  });

  test("build refuses unsafe or duplicate paths", () => {
    expect(() => buildMirrorBundle([{ path: "../x", kind: "verbatim", mode: "0600", bytes: Buffer.alloc(0) }], meta)).toThrow(/unsafe/);
    const dup = entries();
    dup[1]!.path = dup[0]!.path;
    expect(() => buildMirrorBundle(dup, meta)).toThrow(/duplicate/);
  });
});

test("v2 reuses validated bodies across logical worktree destinations without expanding memory", async () => {
  const bytes = Buffer.from("shared support\n".repeat(10000));
  const inputs: BundleInput[] = Array.from({ length: 8 }, (_, index) => ({ path: `work/tree-${index}/docs/support.md`, kind: "verbatim", mode: index % 2 ? "0700" : "0600", bytes }));
  const built = buildMirrorBundle(inputs, meta);
  expect(built.header.version).toBe(2);
  expect(built.bytes.length).toBeLessThan(bytes.length + 4096);
  const parsed = await parseMirrorBundle(built.bytes);
  expect(parsed.files).toHaveLength(8);
  expect(parsed.files.every((file) => file.bytes === parsed.files[0]!.bytes)).toBe(true);
  expect(parsed.files[1]!.mode).toBe("0700");
  expect(parsed.hash).toBe(built.hash);
});

test("v1 remains readable and v2 rejects repeated SHA size mismatches and write amplification", async () => {
  const input = entries();
  const built = buildMirrorBundle(input, meta);
  const encode = (header: unknown, body: Buffer, magic = MIRROR_MAGIC) => {
    const bytes = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    return Buffer.concat([Buffer.from(magic), length, bytes, body]);
  };
  const legacy = await parseMirrorBundle(encode({ ...built.header, version: 1 }, Buffer.concat([...input].sort((a, b) => a.path.localeCompare(b.path)).map((file) => file.bytes)), "CASTMIRROR1\n"));
  expect(legacy.header.version).toBe(1);
  expect(legacy.files.map((file) => file.bytes.toString())).toEqual([...input].sort((a, b) => a.path.localeCompare(b.path)).map((file) => file.bytes.toString()));
  const same = buildMirrorBundle([{ path: "one", kind: "verbatim", mode: "0600", bytes: Buffer.from("a") }, { path: "two", kind: "verbatim", mode: "0600", bytes: Buffer.from("a") }], meta);
  const altered = structuredClone(same.header);
  altered.files[1]!.size = 2;
  await expect(parseMirrorBundle(encode(altered, Buffer.from("a")))).rejects.toThrow(/duplicate SHA body size mismatch/);
  altered.files[0]!.size = 1024 * 1024 * 1024 + 1;
  await expect(parseMirrorBundle(encode(altered, Buffer.from("a")))).rejects.toThrow(/expanded write limit/);
  const tooMany = Array.from({ length: 17 }, (_, index) => ({ path: `file-${index}`, kind: "verbatim" as const, mode: "0600" as const, bytes: Buffer.alloc(64 * 1024 * 1024) }));
  expect(() => buildMirrorBundle(tooMany, meta)).toThrow(/expanded write limit/);
});
