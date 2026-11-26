import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonForkFields } from "./conversations";

// ct-101902: a session the system put aside showed as "Stashed" with no cause,
// because a stash was stored only as a stamp (inbox_stashed_at) and a hidden
// flag (inbox_stash_hidden). A stash must say who or what set it. This checks
// one automatic writer, the daemon's fork that is born stashed, without
// fixing the name the cause field takes: any stash field beyond the stamp and
// the hidden flag, declared on conversations and written with a value.
const STAMP_FIELDS = new Set(["inbox_stashed_at", "inbox_stash_hidden"]);
const causeKeys = (row: Record<string, unknown>) =>
  Object.keys(row).filter((k) => /stash/i.test(k) && !STAMP_FIELDS.has(k));

describe("a stash records its cause", () => {
  test("conversations declare a stash cause field beside the stamp", () => {
    const schema = readFileSync(join(import.meta.dir, "schema.ts"), "utf8");
    const declared = [...schema.matchAll(/^\s*(\w*stash\w*)\s*:/gim)].map((m) => m[1]).filter((k) => !STAMP_FIELDS.has(k));
    expect(declared).not.toEqual([]);
  });

  test("a daemon fork born stashed says the system stashed it, not the person", () => {
    const fields = daemonForkFields({ _id: "conv_origin" } as any, { at_uuid: "task_1:turn_2", copied: 1 }, 1_790_000_000_000) as Record<string, unknown>;
    expect(fields.inbox_stashed_at).toBe(1_790_000_000_000);
    const keys = causeKeys(fields);
    expect(keys).not.toEqual([]);
    for (const k of keys) expect(fields[k]).toBeTruthy();
  });
});
