// The folder a milestone's Start opens the composer in (lib/priorityStartFolder).
import { expect, test } from "bun:test";
import { startFolderFor, type FolderRule } from "../priorityStartFolder";

const rule = (path_prefix: string, team_id: string | null, auto_share: boolean, extra: Partial<FolderRule> = {}): FolderRule => ({ path_prefix, team_id, auto_share, ...extra });
const RULES = [
  rule("/code/union", "union", true),
  rule("/code/codecast", "codecast", true),
  rule("/code/codecast/secret", null, false, { private: true }),
  rule("/code/cc-docs", "codecast", false),
];

test("an auto-share folder mapped to the priority's team, the most recently used first", () => {
  expect(startFolderFor("team:codecast", RULES, ["/code/union/app", "/code/codecast/web", "/code/codecast/cli"])).toEqual({ path: "/code/codecast/web" });
  expect(startFolderFor("team:codecast", RULES, ["/code/codecast/cli", "/code/codecast/web"])).toEqual({ path: "/code/codecast/cli" });
});

test("with no recent folder under it, the rule's own folder; a private lock inside it never counts", () => {
  expect(startFolderFor("team:codecast", RULES, ["/code/codecast/secret/x"])).toEqual({ path: "/code/codecast" });
});

test("no auto-share folder: one mapped without it, its sharing left as the folder keeps it", () => {
  const rules = RULES.filter((r) => r.path_prefix !== "/code/codecast");
  expect(startFolderFor("team:codecast", rules, ["/code/cc-docs/site"])).toEqual({ path: "/code/cc-docs/site" });
});

test("nothing mapped to the team, a personal priority, or a folder off the person's machines: no choice", () => {
  expect(startFolderFor("team:elsewhere", RULES, ["/code/union/app"])).toBeNull();
  expect(startFolderFor("user:me", RULES, ["/code/codecast/web"])).toBeNull();
  expect(startFolderFor("team:codecast", [], ["/code/codecast/web"])).toBeNull();
  expect(startFolderFor("team:union", RULES, ["/code/union/app"], (p) => !p.startsWith("/code/union"))).toBeNull();
});
