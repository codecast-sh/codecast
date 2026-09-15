import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("inbox view menu opens on the first interaction outside panel layers", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/inboxViewMenu.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).toContain("inbox view menu first interaction, portal, selection and dismissal verified");
  expect(result.status).toBe(0);
}, 35_000);
