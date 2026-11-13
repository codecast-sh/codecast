// Two people sorting one big sheet at once: each sort is thousands of cell
// writes sent in 400-op batches, and the batches of the two interleave on the
// server. Whatever the server does with the overlap, the sheet must end up as
// one sort's result or the other's, never rows that neither produced (a row
// copied twice, a row lost, a row whose cells come from two source rows).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { chunkOps, foldOps, toElement, type ArtifactOp } from "../../shared/artifacts/core";
import { buildModel, sortOps, workbookFor } from "../../shared/artifacts/sheets";

setDefaultTimeout(240_000);

const ROWS = 300;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const rosa = await ctx.db.insert("users", { name: "Rosa", email: "rosa@pies.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Pies", invite_code: "PIES1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: rosa, team_id: team, role: "admin", joined_at: 1 } as any);
    const sheet = await ctx.db.insert("docs", {
      user_id: rosa, team_id: team, workspace: `team:${team}`, title: "Orders", content: "", doc_type: "sheet",
      source: "human", created_at: 1, updated_at: 1,
    } as any);
    return { rosa, sheet };
  });
  const as = t.withIdentity({ subject: `${ids.rosa}|session` });
  // Row r: A "Name <scrambled>", B a number, C r itself, so every row's cells can be checked against its source row.
  const seed: ArtifactOp[] = [{ k: "tab:S", put: { kind: "tab", name: "S", order: 0 } }];
  for (let r = 1; r <= ROWS; r++) {
    seed.push({ k: `c:S!A${r}`, put: { kind: "cell", input: `Name ${(r * 7919) % ROWS}` } });
    seed.push({ k: `c:S!B${r}`, put: { kind: "cell", input: String((r * 31) % 97) } });
    seed.push({ k: `c:S!C${r}`, put: { kind: "cell", input: String(r) } });
  }
  for (const batch of chunkOps(seed)) await as.mutation(api.liveArtifacts.apply, { doc_id: ids.sheet, ops: batch });
  return { t, as, ...ids };
}

async function serverModel(t: any, doc: Id<"docs">) {
  const rows = await t.run((ctx: any) => ctx.db.query("live_elements").withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", doc).eq("layer", "main")).collect());
  const state = new Map();
  foldOps(state, rows.filter((r: any) => !r.deleted).map((r: any) => ({ k: r.key, put: { kind: r.kind, ...r.fields } })));
  return buildModel([...state].map(([k, st]) => toElement(k, st)));
}

/** Rows whose cells don't all come from one source row, and source rows that are gone. */
function integrity(model: ReturnType<typeof buildModel>) {
  const cells = model.byId.get("S")!.cells;
  const get = (c: number, r: number) => cells.get(r * 32768 + c)?.input;
  let mixed = 0;
  const seen = new Set<number>();
  for (let r = 1; r <= ROWS; r++) {
    const src = Number(get(3, r));
    if (get(1, r) !== `Name ${(src * 7919) % ROWS}` || get(2, r) !== String((src * 31) % 97)) mixed++;
    seen.add(src);
  }
  return { mixed, missing: ROWS - seen.size };
}

describe("two sorts of one sheet at once", () => {
  test("interleaved batches never leave rows that neither sort produced", async () => {
    const { t, as, sheet } = await setup();
    expect(integrity(await serverModel(t, sheet))).toEqual({ mixed: 0, missing: 0 });
    // Both clients read the same sheet at the same revision, then sort it two different ways.
    const base = await serverModel(t, sheet);
    const baseRev: number = await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("live_elements").withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", sheet).eq("layer", "main")).collect();
      return Math.max(...rows.map((r: any) => r.rev ?? 0));
    });
    const rect = { c0: 1, r0: 1, c1: 3, r1: ROWS };
    const byName = chunkOps(sortOps(base, workbookFor(base), "S", rect, 1, false), 100);
    const byNumber = chunkOps(sortOps(base, workbookFor(base), "S", rect, 2, true), 100);
    // Their batches reach the server alternately; a batch the server refuses ends that client's write.
    // Each write claims the tab it rewrites (scope "tab:S"), from the revision it read.
    const clients = [byName, byNumber].map((batches, n) => ({ batches, refused: false, write: `w${n}` }));
    for (let i = 0; i < Math.max(byName.length, byNumber.length); i++)
      for (const c of clients) {
        if (c.refused || !c.batches[i]) continue;
        const claim = { scope: "tab:S", write: c.write, base: baseRev, first: i === 0, last: i === c.batches.length - 1 };
        try {
          await as.mutation(api.liveArtifacts.apply, { doc_id: sheet, ops: c.batches[i], claim } as any);
        } catch {
          c.refused = true;
        }
      }
    const after = await serverModel(t, sheet);
    expect(integrity(after)).toEqual({ mixed: 0, missing: 0 });
    // Exactly one of the two sorts landed, whole: the sheet reads as that sort's result.
    const done = clients.filter((c) => !c.refused);
    expect(done.length).toBe(1);
    const order = (m: typeof after) => Array.from({ length: ROWS }, (_, i) => m.byId.get("S")!.cells.get((i + 1) * 32768 + 3)?.input);
    const want = done[0].write === "w0" ? sortOps(base, workbookFor(base), "S", rect, 1, false) : sortOps(base, workbookFor(base), "S", rect, 2, true);
    const expected = buildModel([...foldOps(new Map([...base.byId.get("S")!.cells.values()].map((el) => [el.key, { kind: "cell", fields: { input: el.input }, deleted: false } as any]).concat([["tab:S", { kind: "tab", fields: { name: "S", order: 0 }, deleted: false } as any]])), want)].map(([k, st]) => toElement(k, st)));
    expect(order(after)).toEqual(order(expected));
  });
});
