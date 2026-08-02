import { describe, expect, test } from "bun:test";
import { clampMirrorNote, mirrorRowNeedsWrite } from "./vaultMirror";
import { VAULT_MIRROR_MAX_LINKS, VAULT_MIRROR_MAX_TAGS } from "@codecast/shared/contracts";

const row = {
  content_hash: "aaaa",
  title: "A",
  mtime: 100,
  size: 10,
  scan_id: "scan-1",
  body_storage_id: "blob-1",
};
const same = { content_hash: "aaaa", title: "A", mtime: 100, size: 10 };

describe("mirrorRowNeedsWrite", () => {
  test("a note with no row yet always writes", () => {
    expect(mirrorRowNeedsWrite(null, same, "scan-1")).toBe(true);
  });

  test("an unchanged note under the current scan stamp writes nothing", () => {
    expect(mirrorRowNeedsWrite(row, same, "scan-1")).toBe(false);
  });

  test("changed content, title, mtime or size each force a write", () => {
    expect(mirrorRowNeedsWrite(row, { ...same, content_hash: "bbbb" }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, title: "B" }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, mtime: 200 }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, size: 11 }, "scan-1")).toBe(true);
  });

  test("a newly uploaded body forces a write even when the content is unchanged", () => {
    expect(mirrorRowNeedsWrite(row, { ...same, body_storage_id: "blob-2" }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, body_storage_id: "blob-1" }, "scan-1")).toBe(false);
  });

  test("a stale scan stamp forces a write, or the sweep would delete the row", () => {
    expect(mirrorRowNeedsWrite(row, same, "scan-2")).toBe(true);
  });

  test("an incremental push (no scan) leaves an unchanged row alone", () => {
    expect(mirrorRowNeedsWrite(row, same, undefined)).toBe(false);
  });
});

describe("clampMirrorNote", () => {
  test("caps the two arrays that can grow without bound", () => {
    const note = {
      tags: Array.from({ length: VAULT_MIRROR_MAX_TAGS + 40 }, (_, i) => `t${i}`),
      links: Array.from({ length: VAULT_MIRROR_MAX_LINKS + 40 }, (_, i) => `l${i}`),
    };
    const clamped = clampMirrorNote(note);
    expect(clamped.tags).toHaveLength(VAULT_MIRROR_MAX_TAGS);
    expect(clamped.links).toHaveLength(VAULT_MIRROR_MAX_LINKS);
    expect(clamped.links[0]).toBe("l0");
  });

  test("leaves an ordinary note untouched", () => {
    const note = { tags: ["a"], links: ["B"], title: "keep me" };
    expect(clampMirrorNote(note)).toEqual(note);
  });
});
