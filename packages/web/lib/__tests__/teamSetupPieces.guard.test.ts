import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// TEAM SETUP EXTRACTION GUARD.
//
// The visibility levels, the workspace share picker and the save helper each
// live in one module so the join and create team flows cannot drift. This
// fails when a second copy of VISIBILITY_LEVELS appears, or when the join
// flow stops composing the shared pieces.

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

  // The client resolves a parked create (no dispatch binding at click time)
  // by matching the echoed team against the client_key it sent. That match is
  // the only thing standing between a durable create and a bogus "could not
  // create the team", so the projection must keep echoing the field.
  test("getUserTeams echoes client_key back to the client", () => {
    const teams = readFileSync(
      join(root, "..", "convex", "convex", "teams.ts"),
      "utf8",
    );
    const projection = teams.slice(
      teams.indexOf("export const getUserTeams = query"),
      teams.indexOf("export const getUserTeamsV2"),
    );
    expect(projection).toContain("client_key: team.client_key");
  });

  test("the join flow composes the shared pieces", () => {
    const page = readFileSync(join(root, "app", "settings", "team", "join", "page.tsx"), "utf8");
    expect(page).toContain('from "../../../../components/team/VisibilityPicker"');
    expect(page).toContain('from "../../../../components/team/WorkspaceSharePicker"');
    expect(page).toContain('from "../../../../hooks/useTeamWorkspaceSuggestions"');
    expect(page).toContain('from "../../../../lib/team/saveTeamSetup"');
  });
});
