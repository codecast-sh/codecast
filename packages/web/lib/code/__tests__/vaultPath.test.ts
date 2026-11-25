import { expect, test } from "bun:test";
import { resolveVaultPath } from "../vaultPath";

const ROOT = "/Users/me/src/repo";

test("a relative path stays relative, normalized", () => {
  expect(resolveVaultPath("src/a.ts", ROOT)).toEqual({ path: "src/a.ts" });
  expect(resolveVaultPath("./src//b/../a.ts", ROOT)).toEqual({ path: "src/a.ts" });
});

test("an absolute path under the root becomes vault-relative", () => {
  expect(resolveVaultPath(`${ROOT}/package.json`, ROOT)).toEqual({ path: "package.json" });
  expect(resolveVaultPath(`${ROOT}/src/new.ts`, `${ROOT}/`)).toEqual({ path: "src/new.ts" });
});

test("paths that are not files in the vault are refused, never trimmed into one", () => {
  for (const p of ["/Users/me/src/other/x.ts", "/Users/me/src/repository/x.ts", "~/notes.ts", "~", "../x.ts", "src/../../x.ts", ROOT, "", "  ", "."]) {
    expect("refused" in resolveVaultPath(p, ROOT)).toBe(true);
  }
  // No root known: an absolute path cannot be placed.
  expect("refused" in resolveVaultPath(`${ROOT}/a.ts`, null)).toBe(true);
});
