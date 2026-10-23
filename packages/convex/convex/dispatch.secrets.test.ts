// The web's Vault writes ride dispatch side effects (web store removeSecret,
// updateSecretMeta, setSecretAskFirst). A write whose row was deleted since it
// was queued settles quietly; one the caller may not make still refuses, so
// the outbox drops it and the client puts its paint back.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

const api = anyApi as any;
const KEY_ENV = "CONNECTION_SECRETS_KEY";

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-deployment-key-0123456789abcdef";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => ({
    ana: await ctx.db.insert("users", { name: "Ana" } as any),
    cat: await ctx.db.insert("users", { name: "Cat" } as any),
  }));
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const dispatch = (u: string, action: string, args: unknown[]) => as(u).mutation(api.dispatch.dispatch, { action, args });
  await as(String(ids.ana)).action(api.secrets.create, { name: "zz-key", kind: "key", payload: { value: "zz-value-0123456789" }, personal: true });
  const id = String((await as(String(ids.ana)).query(api.secrets.list, {}))[0]._id);
  return { t, ...ids, dispatch, id };
}

test("a Vault write against a secret deleted since it was queued settles quietly", async () => {
  const { t, ana, dispatch, id } = await seed();
  await dispatch(String(ana), "removeSecret", [id]);
  expect(await t.run((ctx) => ctx.db.get(id as any))).toBeNull();
  // The same delete again (a redrive, a second window), an edit and Ask first: all land on nothing, none throws.
  expect(await dispatch(String(ana), "removeSecret", [id])).toBeNull();
  expect(await dispatch(String(ana), "updateSecretMeta", [id, { note: "late" }])).toBeNull();
  expect(await dispatch(String(ana), "setSecretAskFirst", [id, true])).toBeNull();
});

test("a Vault write the caller may not make still refuses", async () => {
  const { t, cat, dispatch, id } = await seed();
  await expect(dispatch(String(cat), "removeSecret", [id])).rejects.toThrow(/No secret/);
  expect(await t.run((ctx) => ctx.db.get(id as any))).not.toBeNull();
});
