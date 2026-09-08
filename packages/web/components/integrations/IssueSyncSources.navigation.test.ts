import { expect, test } from "bun:test";
import { runHibernationChild } from "../../hooks/__tests__/fixtures/runHibernationChild";

test("integration project links navigate the active tab and preserve modified clicks", async () => {
  const { code, signalCode, stdout, stderr } = await runHibernationChild(
    [`${import.meta.dir}/fixtures/issueSyncNavigation.tsx`],
    25_000,
  );
  expect({ code, signalCode, stderr }).toEqual({ code: 0, signalCode: null, stderr: "" });
  expect(stdout).toContain("project navigation scenarios passed");
}, 30_000);
