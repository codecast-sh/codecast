import { describe, expect, test } from "bun:test";
import { ownersLine, ownersView } from "./ownersView.js";

const ME = { name: "Jason Benn", email: "jason@x.ai" };
const MATE = { name: null, email: "dev@x.ai" };
const ROLE = { handle: "eval", name: "Eval lead" };
const PARENT = { short_id: "jxpar01", title: "The lead" };

describe("ownersLine", () => {
  test("without the feature it names the people as before", () => {
    expect(ownersLine({ owners: [ME, MATE] })).toBe("Jason Benn, dev@x.ai");
    expect(ownersLine({ owners: [] })).toBe("nobody");
  });

  test("with the feature: people, the implicit starter, the role, the parent session", () => {
    expect(ownersLine({ session_owners: true, people: [ME, MATE], role: ROLE, parent_session: PARENT })).toBe("Jason Benn, dev@x.ai, @eval, session jxpar01");
    expect(ownersLine({ session_owners: true, people: [], implicit_starter: ME })).toBe("Jason Benn");
    expect(ownersLine({ session_owners: true, people: [] })).toBe("nobody");
  });
});

describe("ownersView", () => {
  test("names each kind of owner and which agent answers it", () => {
    expect(ownersView({ session_owners: true, people: [ME], role: ROLE, parent_session: PARENT, can_edit: true })).toEqual([
      "people:  Jason Benn",
      "role:    @eval (Eval lead), answers it",
      "session: jxpar01 The lead",
      "you can change its owners",
    ]);
  });

  test("the parent session answers when there is no role", () => {
    expect(ownersView({ session_owners: true, people: [], parent_session: { short_id: "jxpar01" }, can_edit: false })).toEqual([
      "session: jxpar01, answers it",
      "you can add yourself: cast own <session>",
    ]);
  });

  test("the starter reads as owning it while nothing else does", () => {
    expect(ownersView({ session_owners: true, people: [], implicit_starter: ME, can_edit: true })[0]).toBe("people:  Jason Benn (started it; owns it while nothing else does)");
  });

  test("never speaks of drivers or pausing", () => {
    const lines = ownersView({ session_owners: true, people: [ME, MATE], role: ROLE, parent_session: PARENT, can_edit: true }).join("\n");
    expect(lines).not.toMatch(/driv|paus/i);
  });
});
