import { describe, expect, test } from "bun:test";
import { chipFilterSection, type InboxSession } from "../inboxStore";

const row = (id: string) => ({ _id: id }) as InboxSession;

describe("chipFilterSection", () => {
  // A project's main session rides its role's standing session, which works in
  // another project; its workers nest under it. The project chip used to drop
  // the standing card and everything under it, leaving the inbox empty.
  const lead = row("lead");
  const main = row("main");
  const worker = row("worker");
  const other = row("other");
  const subs = new Map<string, InboxSession[]>([["lead", [main, row("elsewhere")]], ["main", [worker]]]);
  const inProject = new Set(["main", "worker"]);
  const matches = (s: InboxSession) => inProject.has(s._id);

  test("a matching row nested under a dropped card stands in its place", () => {
    expect(chipFilterSection([lead, other], subs, matches).map((s) => s._id)).toEqual(["main"]);
  });

  test("a matching card keeps its nested rows under it, not beside it", () => {
    expect(chipFilterSection([main], subs, matches).map((s) => s._id)).toEqual(["main"]);
  });

  test("a cycle in the nesting ends the walk", () => {
    const loop = new Map<string, InboxSession[]>([["a", [row("b")]], ["b", [row("a")]]]);
    expect(chipFilterSection([row("a")], loop, () => false)).toEqual([]);
  });
});
