import { create } from "mutative";
import { test, expect } from "bun:test";
const opts = { enablePatches: { pathAsArray: true } } as const;
test("row.reply = intent.reply through the draft", () => {
  const base = { orgIntents: [{ kind: "noteChange", change_id: "a", reply: { verdict: "note", at: 2 } }], orgProposalChanges: { a: { status: "open" } as any } };
  const [next] = create(base, (d: any) => {
    for (const i of d.orgIntents) d.orgProposalChanges[i.change_id].reply = i.reply;
  }, opts as any);
  expect(() => Object.getPrototypeOf(next.orgProposalChanges.a.reply)).not.toThrow();
  // then a later sync reads it
  const [n2] = create(next, (d: any) => { d.x = d.orgProposalChanges.a.reply?.verdict; }, opts as any);
});
test("intent.from = row.reply, row.reply replaced, intent pushed", () => {
  const base = { orgIntents: [] as any[], orgProposalChanges: { a: { status: "open", reply: { verdict: "note", at: 1 } } as any } };
  const [next] = create(base, (d: any) => {
    const c = d.orgProposalChanges.a;
    const intent = { kind: "noteChange", change_id: "a", reply: { verdict: "note", at: 2 }, from: c.reply };
    c.reply = intent.reply;
    d.orgIntents = [...d.orgIntents, intent];
  }, opts as any);
  expect(() => Object.getPrototypeOf(next.orgIntents[0].from)).not.toThrow();
});
