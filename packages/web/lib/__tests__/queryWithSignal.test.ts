import { expect, test } from "bun:test";
import { runHibernationChild } from "../../hooks/__tests__/fixtures/runHibernationChild";

test("recovery cancellation removes real Convex subscriptions in isolation", async () => {
  const { code, stdout, stderr } = await runHibernationChild([
    "test", `${import.meta.dir}/fixtures/queryWithSignal.ts`,
  ], 10_000);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("2 pass");
}, 12_000);
