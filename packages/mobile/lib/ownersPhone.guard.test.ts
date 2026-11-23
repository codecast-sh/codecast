import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone's owners surfaces keep step with the web's: the same leave box
// and outside-tap guard in the owners sheet, the same paused-role mark and
// "With <role>" wording on rows, and the same heartbeat discipline, since the
// composer line and the header chip stay mounted while a session is open.
// Source-level, because these are RN components bun cannot render.

const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

describe("rows and faces", () => {
  const row = src("components/SessionItem.tsx");
  test("\"With <role>\" rides a coarse clock and names the role in full, as web does", () => {
    expect(row).toMatch(/useNowWhen\(\(t\) => withRoleOf\(session as any, t\)/);
    expect(row).not.toContain("withRoleOf(session as any, Date.now())");
    expect(row).toContain("With {withRole}");
  });

  test("a paused role wears a dashed ring, not a fade alone", () => {
    expect(src("components/owners/OwnerFace.tsx")).toMatch(/paused: \{[^}]*borderStyle: 'dashed'/);
  });
});
