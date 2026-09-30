import { expect, test } from "bun:test";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("a denied inbox deep link shows the note, never the previous session", () => {
  const directory = mkdtempSync(join(tmpdir(), "inbox-unavailable-link-"));
  const resultPath = join(directory, "result");
  try {
    execFileSync(process.execPath, [join(import.meta.dir, "fixtures/inboxUnavailableDeepLink.tsx"), resultPath], {
      timeout: 120_000,
    });
    expect(readFileSync(resultPath, "utf8")).toContain("unavailable inbox deep link verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
