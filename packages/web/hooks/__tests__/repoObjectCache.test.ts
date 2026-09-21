import { expect, test } from "bun:test";
import { runHibernationChild } from "./fixtures/runHibernationChild";

test("repository objects persist as they are used and recover failed lookups", async () => {
  const result = await runHibernationChild(["test", `${import.meta.dir}/fixtures/repoObjectCache.tsx`], 180_000);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain("7 pass");
}, 185_000);
