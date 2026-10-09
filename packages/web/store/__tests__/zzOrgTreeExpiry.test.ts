import { expect, it } from "bun:test";
import { ORG_INTENT_TTL_MS } from "../orgSlice";
import { useInboxStore } from "../inboxStore";
import { ORG_FIXTURE } from "../../components/org/orgFixture";

it("an orgTree push expires a note intent and reverts its stamp", () => {
  const store = () => useInboxStore.getState() as any;
  const row = { _id: "c1", proposal_id: "p", seq: 1, change: { kind: "retire", handle: "x" }, rationale: "r", evidence: [], status: "proposed", reply: { verdict: "note", text: "old", at: 1, by: "u0" } };
  store().syncTable("orgProposalChanges", [row]);
  // Real action: the intent's `from` is read off the draft.
  store().replyOnOrgProposal("p", [{ verdict: "note", change_ids: ["c1"], seqs: [1], text: "hi" }], { revised_at: 0, seqs: [1] });
  // Unconfirmed note replayed onto a stale push (the leak path before the fix).
  store().syncTable("orgProposalChanges", [{ ...row }]);
  try { Object.getPrototypeOf(store().orgProposalChanges.c1.reply); console.log("LEAK? no", JSON.stringify(store().orgProposalChanges.c1.reply), JSON.stringify(store().orgIntents)); } catch { console.log("LEAK yes"); }
  useInboxStore.setState({ orgIntents: store().orgIntents.map((i: any) => ({ ...i, at: Date.now() - ORG_INTENT_TTL_MS - 1 })) } as any);
  // The stack's path: orgTree normalize -> expire -> revert noteChange.
  store().syncTable("orgTree", JSON.parse(JSON.stringify(ORG_FIXTURE)));
  expect(store().orgIntents.filter((i: any) => i.kind === "noteChange")).toEqual([]);
  expect(JSON.parse(JSON.stringify(store().orgProposalChanges.c1.reply))).toMatchObject({ text: "old" });
  store().syncTable("orgTree", JSON.parse(JSON.stringify(ORG_FIXTURE)));
});
