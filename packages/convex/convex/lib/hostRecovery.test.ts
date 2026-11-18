// A machine that gains an account books a recovery pass, so sessions parked
// on its spent accounts move onto the new one instead of sleeping until reset.
import { expect, test } from "bun:test";
import { scheduleRecoveryOnNewAccount } from "./hostRecovery";

function recorder() {
  const calls: unknown[] = [];
  return { calls, ctx: { scheduler: { runAfter: async (_ms: number, _fn: unknown, args: unknown) => void calls.push(args) } } };
}
const user = "u1" as any;
const before = { profiles: [{ email: "claude3@x.com" }, { email: "claude6@x.com" }] };

test("a new account on a machine books a pass", async () => {
  const r = recorder();
  await scheduleRecoveryOnNewAccount(r.ctx, user, { previous: before, ccAccounts: { profiles: [...before.profiles, { email: "Claude@x.com" }] } });
  expect(r.calls).toEqual([{ user_id: user }]);
});

test("the same accounts, a lost one, a first beat or an unchanged beat book nothing", async () => {
  const r = recorder();
  await scheduleRecoveryOnNewAccount(r.ctx, user, { previous: before, ccAccounts: before });
  await scheduleRecoveryOnNewAccount(r.ctx, user, { previous: before, ccAccounts: { profiles: [before.profiles[0]] } });
  await scheduleRecoveryOnNewAccount(r.ctx, user, { previous: undefined, ccAccounts: before });
  await scheduleRecoveryOnNewAccount(r.ctx, user, { previous: before, ccAccounts: undefined });
  expect(r.calls).toEqual([]);
});
