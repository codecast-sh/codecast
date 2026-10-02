// The conversation is part of the proposal (org-staffing.md S18): the thread
// a proposal binds, what a revise did to a row, and what landed since the
// reader last looked. Run: bun test components/org/staffingRevise.test.ts
import { describe, expect, test } from "bun:test";
import { latestOrgRevisionAt } from "@codecast/shared/contracts/orgProposal";
import { amendedMoves, proposalThread, revisedLine, revisedSince, revisionWord } from "./staffingRevise";
import { proposalProgress } from "./staffingModel";
import { ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL, ORG_STAFFING_FIXTURE_SESSION_PROPOSAL } from "./orgStaffingFixture";
import { ORG_FIXTURE } from "./orgFixture";
import { parseProposalMessage } from "@codecast/shared/contracts";
import { aboutChangeHeader, parseAboutChange, withAboutChange } from "@codecast/shared/contracts/orgProposal";

const headOfPeopleTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-head", short_id: "or-9", handle: "head-of-people", name: "Head of People", standing: { conversation_id: "fixture-head-standing", short_id: "jx7stnd" } }] };

describe("proposalThread", () => {
  test("the server's pointer wins, named after the role", () => {
    const t = proposalThread(ORG_STAFFING_FIXTURE_REVISED_PROPOSAL, headOfPeopleTree);
    expect(t).toMatchObject({ conversationId: "fixture-head-conv", shortId: "jx7ch1f", name: "Head of People", named: true });
    expect(t!.role?._id).toBe("fixture-role-head");
  });
  test("a session author's conversation is the thread until the pointer lands", () => {
    const t = proposalThread(ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, headOfPeopleTree);
    expect(t).toMatchObject({ conversationId: "fixture-conv-review", shortId: "jx7rev1", name: "the author of this proposal", named: false, role: null });
  });
  test("a role author without a pointer answers from its standing session", () => {
    const { thread: _t, ...noPointer } = ORG_STAFFING_FIXTURE_PROPOSAL;
    expect(proposalThread(noPointer, headOfPeopleTree)?.conversationId).toBe("fixture-head-standing");
    expect(proposalThread(noPointer, ORG_FIXTURE)).toBeNull();
  });
  test("null on the row means a person posted it: nobody to talk to", () => {
    expect(proposalThread({ ...ORG_STAFFING_FIXTURE_PROPOSAL, thread: null }, headOfPeopleTree)).toBeNull();
  });
});

describe("what a revise did", () => {
  const rows = ORG_STAFFING_FIXTURE_REVISED_PROPOSAL.changes;
  test("an amend lists the fields that moved, old and new", () => {
    // A limit is quiet (S23.2): a person never reads it, so its amend lists nothing.
    expect(amendedMoves(rows.find((c) => c._id === "fixture-change-93")!)).toEqual([]);
    expect(amendedMoves({
      change: { kind: "role", name: "Growth lead", handle: "growth", charter: "Grows intros per day." },
      revision: { kind: "amended", note: "x", at: 1, before: { kind: "role", name: "Growth lead", handle: "growth", charter: "Grows intros." } },
    } as any)).toEqual([{ key: "charter", label: "charter", from: "Grows intros.", to: "Grows intros per day." }]);
    expect(amendedMoves(rows.find((c) => c._id === "fixture-change-92")!)).toEqual([]);
    // A scope amend speaks the row's words, not the raw key.
    expect(amendedMoves({
      change: { kind: "scope", handle: "product", add: ["Codecast: Agents & Clients"] },
      revision: { kind: "amended", note: "x", at: 1, before: { kind: "scope", handle: "product", add: ["Codecast: Agents & Clients", "Codecast: Calls & Presence"] } },
    })).toEqual([{ key: "add", label: "also looks after", from: "Codecast: Agents & Clients, Codecast: Calls & Presence", to: "Codecast: Agents & Clients" }]);
    expect(revisionWord(rows.find((c) => c._id === "fixture-change-93")!.revision!)).toBe("Changed");
  });
  test("a removed change leaves the count", () => {
    const p = proposalProgress(ORG_STAFFING_FIXTURE_REVISED_PROPOSAL);
    expect(p.total).toBe(4);
    expect(p.decided).toBe(1);
    expect(p.remaining).toBe(3);
  });
  test("since the reader last looked", () => {
    const latest = latestOrgRevisionAt(rows);
    expect(revisedSince(rows, latest)).toEqual([]);
    const all = revisedSince(rows, 0);
    expect(all.map((c) => c.revision!.kind)).toEqual(["added", "removed"] /* the amended row is a limit (S23.2): never read, so never in the strip */);
    expect(revisedLine(all, "Head of People")).toBe("Head of People removed 1 and added 1 since you last looked.");
    expect(revisedLine(all.slice(0, 1), "Head of People")).toBe("Head of People added 1 since you last looked.");
    expect(revisedLine([], "x")).toBe("");
    expect(revisedLine(all.slice(0, 1), "the author of this proposal")).toBe("The author of this proposal added 1 since you last looked.");
  });
});

describe("the message names the row", () => {
  test("header round trip", () => {
    const content = withAboutChange("growth is dead, drop it", "op-12", 3, 'Hire a "Head" of Platform');
    expect(content.startsWith(aboutChangeHeader("op-12", 3, "Hire a 'Head' of Platform"))).toBe(true);
    expect(parseAboutChange(content)).toEqual({ proposal: "op-12", seq: 3, line: "Hire a 'Head' of Platform", body: "growth is dead, drop it" });
    expect(parseAboutChange("plain words")).toBeNull();
  });
  test("the server's wrapper reads back as the person's words under the row", () => {
    const wire = `<proposal-message proposal="op-12" change="3" from="Ashot">\nAbout op-12 change 3 ("Hire a Head of Platform, reporting to you"):\n\ngrowth is dead, drop it\n\n(Reply here; the org page shows this thread beside op-12. To change the proposal run \`cast org revise op-12 --remove 3\`.)\n</proposal-message>`;
    expect(parseProposalMessage(wire)).toEqual({ proposal: "op-12", change: 3, from: "Ashot", about: 'About op-12 change 3 ("Hire a Head of Platform, reporting to you"):', body: "growth is dead, drop it" });
    const whole = `<proposal-message proposal="op-12" from="Ashot">\nwhy is growth in there\n</proposal-message>`;
    expect(parseProposalMessage(whole)).toEqual({ proposal: "op-12", change: null, from: "Ashot", about: null, body: "why is growth in there" });
    expect(parseProposalMessage("<user-message from=\"x\">hi</user-message>")).toBeNull();
  });
});
