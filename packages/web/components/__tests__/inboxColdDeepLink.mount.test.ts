import { expect, test } from "bun:test";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("a cold inbox deep link paints its fetched conversation and preserves Back", () => {
  const directory = mkdtempSync(join(tmpdir(), "inbox-cold-link-"));
  const resultPath = join(directory, "result");
  try {
    execFileSync(process.execPath, [join(import.meta.dir, "fixtures/inboxColdDeepLink.tsx"), resultPath], {
      timeout: 120_000,
    });
    expect(readFileSync(resultPath, "utf8")).toContain("cold inbox deep link verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
