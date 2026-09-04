import { expect, test } from "bun:test";
import { parseOrphanProcessIdentity } from "./orphanProcessIdentity.js";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const start = "Sat Sep  5 12:00:00 2026";
const row = `${start} 501 1 claude --session-id ${id}`;

test("orphan identity requires a complete exact session, UID, start and orphan parent", () => {
  const identity = parseOrphanProcessIdentity(row, id, 501);
  expect(identity).toMatchObject({ start, uid: 501, command: `claude --session-id ${id}` });
  for (const invalid of ["", "garbage", row + "\n" + row, row.replace(start, "unknown"),
    row.replace("501 1", "501x 1"), row.replace("501 1", "501 2"), row.replace("501 1", "502 1"),
    row.replace("--session-id", "prompt"), row + "-suffix", row.replace(id, id.slice(0, 8))]) {
    expect(parseOrphanProcessIdentity(invalid, id, 501)).toBeNull();
  }
  expect(parseOrphanProcessIdentity(row, id, undefined)).toBeNull();
  expect(parseOrphanProcessIdentity(row.replace("12:00:00", "12:00:01"), id, 501)).not.toEqual(identity);
});
