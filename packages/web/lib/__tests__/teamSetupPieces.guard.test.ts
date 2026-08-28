import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// TEAM SETUP EXTRACTION GUARD.
//
// The visibility levels, the workspace share picker and the save helper each
// live in one module so the setup dialog and the create team flow cannot
// drift. This fails when a second copy of VISIBILITY_LEVELS appears, or when
// the dialog stops composing the shared pieces.

const root = join(import.meta.dir, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

describe("team setup pieces are defined once", () => {
  test("VISIBILITY_LEVELS has a single definition", () => {
    const files = ["app", "components", "hooks", "lib"].flatMap((d) => walk(join(root, d)));
    const defining = files.filter((f) => /\bVISIBILITY_LEVELS\s*=/.test(readFileSync(f, "utf8")));
    expect(defining.map((f) => f.slice(root.length + 1))).toEqual([
      "lib/team/visibilityLevels.ts",
    ]);
  });

  test("TeamSetupDialog composes the shared pieces", () => {
    const dialog = readFileSync(join(root, "components", "TeamSetupDialog.tsx"), "utf8");
    expect(dialog).toContain('from "./team/VisibilityPicker"');
    expect(dialog).toContain('from "./team/WorkspaceSharePicker"');
    expect(dialog).toContain('from "../hooks/useTeamWorkspaceSuggestions"');
    expect(dialog).toContain('from "../lib/team/saveTeamSetup"');
    expect(dialog).not.toContain("useMutation(");
    expect(dialog).not.toContain("useQuery(");
  });
});
