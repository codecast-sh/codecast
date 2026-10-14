// ownerUnlock opens a gated page inside the app for its owner and for whoever
// may read the decision the page was filed on (a trial gates its decision
// pages because they quote a customer; the decision's own readers still read
// them). Nobody else gets the tokens, and a decision opens only the pages it
// filed. Runs the handler against a tiny fake db (as artifacts.listForWeb.test.ts).
import { describe, expect, test } from "bun:test";
import { ownerUnlock } from "./artifacts";

function fakeCtx(viewer: string, rows: Record<string, any[]>) {
  const byId = new Map<string, any>();
  for (const table of Object.values(rows)) for (const r of table) byId.set(r._id, r);
  return {
    auth: { getUserIdentity: async () => ({ subject: `${viewer}|sess`, tokenIdentifier: "x" }) },
    db: {
      query: (table: string) => ({
        withIndex: (_i: string, builder: any) => {
          const eqs: Array<[string, any]> = [];
          builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
          const hit = (rows[table] ?? []).filter((r) => eqs.every(([f, v]) => String(r[f]) === String(v)));
          return { collect: async () => hit, first: async () => hit[0] ?? null };
        },
      }),
      get: async (id: string) => byId.get(id) ?? null,
      normalizeId: (_t: string, id: string) => (byId.has(id) ? id : null),
    },
  } as any;
}

const rows = () => ({
  artifacts: [
    { _id: "a1", slug: "trialpage", user_id: "owner", title: "The fix", version: 2, password_hash: "h1", created_at: 1, updated_at: 1 },
    { _id: "a2", slug: "otherpage", user_id: "owner", title: "Other", version: 1, password_hash: "h2", created_at: 1, updated_at: 1 },
  ],
  session_decisions: [
    // The asking conversation is not readable in this fake: only being asked lets a viewer in.
    { _id: "d1", short_id: "sd-1", user_id: "owner", asked_user_ids: ["asked"], conversation_id: "gone", report_slug: "trialpage", options: [{ label: "Ship", page_slug: "otherpage" }] },
    { _id: "d2", short_id: "sd-2", user_id: "owner", asked_user_ids: ["asked"], conversation_id: "gone", options: [{ label: "Ship" }] },
  ],
});

const unlock = (viewer: string, args: { slug: string; decision?: string }) =>
  ((ownerUnlock as any)._handler ?? (ownerUnlock as any).handler)(fakeCtx(viewer, rows()), args);

describe("ownerUnlock", () => {
  test("the owner opens their gated page", async () => {
    const got = await unlock("owner", { slug: "trialpage" });
    expect(got?.k).toBeTruthy();
    expect(got?.title).toBe("The fix");
  });

  test("a person the decision asks opens the pages it filed, its report and an option's page", async () => {
    expect((await unlock("asked", { slug: "trialpage", decision: "sd-1" }))?.k).toBeTruthy();
    expect((await unlock("asked", { slug: "otherpage", decision: "d1" }))?.k).toBeTruthy();
  });

  test("a decision opens only pages it filed, and only for its readers", async () => {
    expect(await unlock("asked", { slug: "trialpage", decision: "sd-2" })).toBeNull();
    expect(await unlock("stranger", { slug: "trialpage", decision: "sd-1" })).toBeNull();
    expect(await unlock("asked", { slug: "trialpage" })).toBeNull();
  });
});
