import { it } from "bun:test";
import { create } from "mutative";
import { createOrgSlice } from "../orgSlice";
import { ORG_FIXTURE } from "../../components/org/orgFixture";

const walk = (v: any, path: string, seen = new Set()) => {
  if (!v || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  try { Object.getPrototypeOf(v); } catch { throw new Error("revoked at " + path); }
  for (const k of Object.keys(v)) walk(v[k], path + "." + k, seen);
};
const stamp = { verdict: "note", text: "earlier", at: 1, by: "u" };

it("reply on a stamped row: patches", () => {
  const st: any = {
    orgTree: JSON.parse(JSON.stringify(ORG_FIXTURE)), orgLog: {}, orgIntents: [], orgIntentNotice: null, orgFocusChangeId: null,
    orgProposals: { p: { _id: "p", short_id: "op-1", status: "open", created_at: 1, reply: stamp } },
    orgProposalChanges: {
      c1: { _id: "c1", proposal_id: "p", seq: 1, change: { kind: "retire", handle: "x" }, status: "proposed", reply: stamp },
      c2: { _id: "c2", proposal_id: "p", seq: 2, change: { kind: "retire", handle: "y" }, status: "proposed", reply: { ...stamp } },
    },
  };
  const slice = createOrgSlice() as any;
  const [next, patches] = create(st, (d: any) => {
    slice.replyOnOrgProposal.call(d, "p", [
      { verdict: "reject", change_ids: ["c1"], seqs: [1], text: "no" },
      { verdict: "note", change_ids: ["c2"], seqs: [2], text: "again" },
      { verdict: "note", change_ids: [], seqs: [], text: "whole" },
    ], {});
  }, { enablePatches: { pathAsArray: true } });
  walk(next, "state");
  walk(patches, "patches");
});
