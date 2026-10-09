// A CLI release lands on its own cadence and the convex push lands on a
// person's, so a CLI is routinely newer than the deployment it talks to. A
// Convex validator is a closed object, so an argument added since that push
// does not arrive unread: the whole call is refused. The rule this file pins
// is which refusals are survivable.
//
//   - An argument that only ENRICHES A READ is dropped and the read asked
//     again (castApi.enrichedRead). The answer loses a line; the command runs.
//   - An argument carrying WRITE INTENT — an effort, a label, a link, a wait,
//     the session a write is attributed to — fails loudly and names what the
//     deployment cannot take yet (contracts/convexErrors, cliErrorMessage).
//     Dropping one writes something other than what the person asked for.
//
// The proved failure: /cli/plans/get gained a viewer, and a deployment that
// predated it refused the call, which took out `plan show`, `context`,
// `status` and `wave` together.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enrichedRead } from "./castApi.js";

/** What cliPost throws for an argument the deployment's validator refused:
 *  the human line, with the refused field's name riding along. */
const refuse = (field: string) =>
  Object.assign(new Error(`this codecast server is older than your CLI: it does not take \`${field}\` on this call yet, so it refused the whole call. It needs a newer deployment.`), { unknownArg: field });

/** A poster that refuses every body carrying one of `refuses`, and otherwise
 *  answers with the body it was given, so a test can read what was sent. */
function poster(refuses: string[] = []) {
  const sent: Array<Record<string, any>> = [];
  const post = async (_route: string, body: Record<string, any>) => {
    sent.push(body);
    const bad = refuses.find((f) => f in body);
    if (bad) throw refuse(bad);
    return { body };
  };
  return { post, sent };
}

describe("a read's enrichment is dropped when the deployment refuses it", () => {
  test("the refused argument goes and the read is asked again", async () => {
    const { post, sent } = poster(["conversation_id"]);
    const answer = await enrichedRead(post, "/cli/plans/get", { short_id: "pl-851" }, { conversation_id: "sess-1" });
    expect(answer.body).toEqual({ short_id: "pl-851" });
    expect(sent).toEqual([{ short_id: "pl-851", conversation_id: "sess-1" }, { short_id: "pl-851" }]);
  });

  test("nothing is dropped when the deployment takes the argument", async () => {
    const { post, sent } = poster();
    const answer = await enrichedRead(post, "/cli/work/list", { ready: true }, { conversation_id: "sess-1" });
    expect(answer.body).toEqual({ ready: true, conversation_id: "sess-1" });
    expect(sent).toHaveLength(1);
  });

  test("one call when there is nothing to enrich with", async () => {
    const { post, sent } = poster();
    await enrichedRead(post, "/cli/work/get", { short_id: "ct-1" }, {});
    // An undefined value is not an offer: a person with no session sends no viewer.
    await enrichedRead(post, "/cli/work/get", { short_id: "ct-2" }, { conversation_id: undefined });
    expect(sent).toEqual([{ short_id: "ct-1" }, { short_id: "ct-2", conversation_id: undefined }]);
  });

  // A validator names one extra field at a time, so two arguments the
  // deployment has never heard of take two refusals to shed.
  test("several refused arguments are shed one per attempt", async () => {
    const { post, sent } = poster(["conversation_id", "include_ephemeral"]);
    const answer = await enrichedRead(post, "/cli/work/list", { limit: 50 }, { conversation_id: "sess-1", include_ephemeral: true });
    expect(answer.body).toEqual({ limit: 50 });
    expect(sent).toHaveLength(3);
  });
});

describe("a refusal that is not a droppable enrichment is the caller's to report", () => {
  // The whole point of the rule: an argument in `base` is what the read means.
  // Dropping one answers a different question, so it is never dropped — and an
  // argument carrying write intent is never offered as enrichment at all.
  test("a refusal naming a field of the body is rethrown, not dropped", async () => {
    const { post, sent } = poster(["label"]);
    const err = await enrichedRead(post, "/cli/work/list", { label: "api" }, { conversation_id: "sess-1" }).catch((e) => e);
    expect((err as { unknownArg?: string }).unknownArg).toBe("label");
    expect(String(err)).toContain("older than your CLI");
    // The first attempt, and no silent retry that would answer unlabelled rows.
    expect(sent).toHaveLength(1);
  });

  test("an ordinary failure is rethrown untouched", async () => {
    const post = async () => { throw new Error("Task not found"); };
    const err = await enrichedRead(post, "/cli/work/get", { short_id: "ct-9" }, { conversation_id: "sess-1" }).catch((e) => e);
    expect(String(err)).toContain("Task not found");
  });
});

// Which routes may take the drop-and-retry at all. A write route here would be
// the rule inverted: a refused `waits`, `effort` or `found_during` dropped and
// retried files the task WITHOUT the blocker, the effort or the link the person
// asked for, and reports success.
describe("only reads take the drop-and-retry (task-graph.md TG9)", () => {
  const sources = ["index.ts", "taskGraphCommands.ts"].map((f) => readFileSync(join(import.meta.dir, f), "utf8"));

  /** Every route the sources read through the enrichment path. */
  const enrichedRoutes = sources.flatMap((src) =>
    [...src.matchAll(/(?:cliReadEnriched|enrichedRead)\((?:deps\.cliPost,\s*)?"([^"]+)"/g)].map((m) => m[1]!));

  const READS = ["/cli/plans/get", "/cli/work/list", "/cli/work/get"];

  // Every route this plan added or widened that carries write intent.
  const WRITES = [
    "/cli/work/create", "/cli/work/update", "/cli/work/claim",
    "/cli/work/dep", "/cli/work/undep", "/cli/work/wait", "/cli/work/unwait",
    "/cli/work/supersede", "/cli/work/relate", "/cli/work/unrelate",
  ];

  test("the enrichment path is used, and only for reads", () => {
    expect(enrichedRoutes.length).toBeGreaterThan(0);
    for (const route of enrichedRoutes) expect(READS).toContain(route);
  });

  test("no write route is read through it", () => {
    for (const route of WRITES) expect(enrichedRoutes).not.toContain(route);
  });

  // The loud path, pinned: a write still goes through the plain poster, whose
  // failure prints cliErrorMessage's line naming the refused argument.
  test("every write route still posts plainly", () => {
    for (const route of WRITES) {
      // The route may be chosen by a ternary inside the call (`--remove` picks
      // unrelate over relate), so the match allows argv between the two.
      const plain = new RegExp(`cliPost\\([^;]{0,60}"${route}"`);
      const posted = sources.some((src) => plain.test(src));
      expect(posted, `${route} is posted through cliPost`).toBe(true);
    }
  });
});
