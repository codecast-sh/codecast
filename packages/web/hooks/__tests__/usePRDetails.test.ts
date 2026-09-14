import { expect, test } from "bun:test";
import { runHibernationChild } from "./fixtures/runHibernationChild";

test("PR tabs load, retry and render live store details", async () => {
  const result = await runHibernationChild(["test", `${import.meta.dir}/fixtures/usePRDetails.tsx`], 180_000);
  expect(result).toMatchObject({ code: 0 });
  expect(result.stderr).toContain("5 pass");
}, 185_000);
