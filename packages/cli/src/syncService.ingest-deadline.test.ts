import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("Convex HTTP cancels expired ingestion requests over real TCP", async () => {
  const result = await promisify(execFile)(process.execPath, [
    "test", `${import.meta.dir}/test-helpers/ingestHttpDeadline.ts`,
  ], { timeout: 10_000 });
  expect(result.stderr).toContain("4 pass");
}, 12_000);
