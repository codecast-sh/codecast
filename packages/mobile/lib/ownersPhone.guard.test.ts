import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone's owners surfaces keep step with the web's: the same leave box
// and outside-tap guard in the owners sheet, the same paused-role mark and
// "With <role>" wording on rows, and the same heartbeat discipline, since the
// composer line and the header chip stay mounted while a session is open.
// Source-level, because these are RN components bun cannot render.

const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
const chip = src("components/AssignmentChip.tsx");

describe("the owners sheet", () => {
  test("a leave target says whose machine it is, with their face", () => {
    expect(chip).toContain("machineOf(owner.name, deviceDisplayName(dev))");
    expect(chip).toMatch(/owner\.name\s*\?\s*<OwnerFace person=/);
  });

  test("a backdrop tap keeps a staged change", () => {
    expect(chip).toMatch(/style=\{styles\.backdrop\} onPress=\{\(\) => \{ if \(!dirty\) close\(\); \}\}/);
    expect(chip).toContain("useEffect(() => onDirty(m.dirty), [m.dirty])");
  });

  test("the owners come before the machines", () => {
    expect(chip.indexOf("'Owners · whose inbox'")).toBeLessThan(chip.indexOf("<Text style={styles.sectionLabel}>Device</Text>"));
  });

  test("the header chip is a 44pt target in its own layout, not hitSlop alone", () => {
    expect(chip).toMatch(/chipTarget: \{\s*minHeight: 44,/);
    expect(chip).toContain("style={styles.chipTarget}");
  });
});

describe("heartbeats", () => {
  test("the composer line and the header chip read the roster's identity, not the raw roster", () => {
    for (const file of ["components/session/ComposerOwnerStrip.tsx", "components/AssignmentChip.tsx"]) {
      const s = src(file);
      expect(s).not.toContain("useInboxStore(teamMembersOf)");
      expect(s).toContain("useInboxStore(rowEnvRoster)");
    }
  });
});

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

  test("a row's owner faces read as one label that names each owner and the driver or paused role", () => {
    expect(row).toContain("<RNView style={styles.coOwners} accessible accessibilityLabel={coOwners.title}>");
  });
});
