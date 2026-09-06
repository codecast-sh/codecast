// The listener budget runs in a child process, and that isolation is the whole
// point of this file.
//
// bun's module mocks are process-global and never restored across files, and a
// sibling substitutes the store hook with a NON-SUBSCRIBING reader
// (components/__tests__/mockInboxStore). Under that substitution the mounted
// panel registers no subscriptions at all, so every count in the budget reads
// zero and the pins pass on a lie. A child process gets the real store, so the
// numbers mean what they say. Same shape as the hibernation subscription guard,
// whose child runner this reuses.
import { expect, test } from "bun:test";
import { runHibernationChild } from "../../hooks/__tests__/fixtures/runHibernationChild";

test("store listener budgets hold for the sidebar and an inbox card", async () => {
  const { code, stdout, stderr } = await runHibernationChild(
    ["test", `${import.meta.dir}/fixtures/listenerBudget.tsx`],
    150_000,
  );
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("2 pass");
}, 160_000);
