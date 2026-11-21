import { describe, expect, it } from "bun:test";
import { joinPlan, joinedText, textEdit, SharedDraftSession, type SharedDraftServer } from "../sharedDraft";
import { inSharedDraft, othersWriting, waitsToJoin } from "../../hooks/useSharedDraft";

/** docSync's step log in memory: the same version rules getSteps/submitSteps apply. */
function fakeServer() {
  const deltas: Array<{ version: number; clientId: string; steps: string[] }> = [];
  const snaps: Array<{ version: number; content: string }> = [];
  const head = () => deltas.at(-1)?.version ?? snaps.at(-1)?.version ?? 0;
  const after = (version: number) => {
    const steps: string[] = [];
    const clientIds: string[] = [];
    for (const d of deltas) {
      const start = d.version - d.steps.length;
      d.steps.forEach((s, i) => {
        if (start + i >= version) { steps.push(s); clientIds.push(d.clientId); }
      });
    }
    return { steps, clientIds };
  };
  const server: SharedDraftServer = {
    async snapshot() {
      const s = snaps.at(-1);
      return s ? { content: s.content, version: s.version } : { content: null };
    },
    async steps(_id, version) {
      const r = after(version);
      return { ...r, version: version + r.steps.length };
    },
    async submit(_id, version, clientId, steps) {
      const missing = after(version);
      if (missing.steps.length) return { status: "needs-rebase", ...missing };
      deltas.push({ version: version + steps.length, clientId, steps });
      return { status: "synced" };
    },
    async saveSnapshot(_id, version, content) {
      snaps.push({ version, content });
    },
  };
  return { server, head, snaps };
}

function box(server: SharedDraftServer, clientId: string) {
  const shown: string[] = [];
  const edits: string[] = [];
  const s = new SharedDraftSession("compose:c1", clientId, server, {
    text: (next) => shown.push(next),
    version: () => {},
    remoteEdit: (who) => edits.push(who),
  });
  return { s, shown, edits };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("textEdit", () => {
  it("replaces only the changed middle", () => {
    expect(textEdit("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(textEdit("abc", "ac")).toEqual({ from: 1, to: 2, insert: "" });
    expect(textEdit("same", "same")).toBeNull();
  });
  it("puts a repeated character where the caret is", () => {
    // Typing "a" at the start of "aa": the caret ends at 1.
    expect(textEdit("aa", "aaa", 1)).toEqual({ from: 0, to: 0, insert: "a" });
    expect(textEdit("aa", "aaa")).toEqual({ from: 2, to: 2, insert: "a" });
  });
});

describe("joinPlan", () => {
  it("never drops anyone's words", () => {
    expect(joinPlan("", "mine", { seed: false, othersLive: false })).toBe("replace");
    expect(joinPlan("theirs", "", { seed: true, othersLive: true })).toBe("adopt");
    expect(joinPlan("theirs and mine", "mine", { seed: true, othersLive: false })).toBe("adopt");
    expect(joinPlan("theirs", "mine", { seed: false, othersLive: false })).toBe("append");
    expect(joinPlan("theirs", "mine", { seed: true, othersLive: true })).toBe("append");
    expect(joinedText("theirs\n", "mine", "append")).toBe("theirs\n\nmine");
  });
  it("lets the owner's box replace a leftover nobody is in", () => {
    expect(joinPlan("old words", "new words", { seed: true, othersLive: false })).toBe("replace");
  });
});

describe("SharedDraftSession", () => {
  it("joins two boxes into one draft and converges under concurrent typing", async () => {
    const { server } = fakeServer();
    const a = box(server, "ann~1");
    const b = box(server, "cam~1");
    expect(await a.s.join(() => "fix the login", { seed: true, othersLive: () => false })).toBe("fix the login");
    await settle();
    expect(await b.s.join(() => "", { seed: false, othersLive: () => true })).toBe("fix the login");

    // Both type at once, against the same version.
    a.s.edit("fix the login bug");
    b.s.edit("please fix the login");
    for (let i = 0; i < 5; i++) {
      await settle();
      const r = await server.steps("compose:c1", 0);
      a.s.receive(0, r.steps, r.clientIds);
      b.s.receive(0, r.steps, r.clientIds);
    }
    expect(a.s.text).toBe("please fix the login bug");
    expect(b.s.text).toBe("please fix the login bug");
    expect(a.shown.at(-1)).toBe("please fix the login bug");
    expect(a.edits).toContain("cam");
    expect(b.edits).toContain("ann");
  });

  it("joining never replaces the words of a box already in the draft, focused or not", async () => {
    const { server } = fakeServer();
    const ann = box(server, "ann~1");
    const cam = box(server, "cam~1");
    // Ann's box is in the draft but not focused: her row has no caret, only in_draft.
    await ann.s.join(() => "fix the login bug", { seed: true, othersLive: () => false });
    await settle();
    const annRow = { user_id: "ann", user_name: "Ann", user_color: "#000", in_draft: true };
    expect(annRow).not.toHaveProperty("cursor_pos");
    expect(inSharedDraft(annRow)).toBe(true);
    // Cam (an owner too) opens the page still holding older words of his own: they go under Ann's.
    expect(await cam.s.join(() => "old idea", { seed: true, othersLive: () => [annRow].some(inSharedDraft) })).toBe("fix the login bug\n\nold idea");
  });

  it("a leftover draft nobody is in is replaced by the owner's newer words, though others are on the page", async () => {
    const { server } = fakeServer();
    const old = box(server, "ann~1");
    await old.s.join(() => "fix the login bug", { seed: true, othersLive: () => false });
    await settle();
    old.s.close();
    // Cam is on the page (a row) but his box has not joined: the draft is a leftover.
    const camRow = { user_id: "cam", user_name: "Cam", user_color: "#000" };
    const ann = box(server, "ann~2");
    expect(await ann.s.join(() => "fix the login bug on mobile", { seed: true, othersLive: () => [camRow].some(inSharedDraft) })).toBe("fix the login bug on mobile");
  });

  it("two owners arriving together, each holding words: they join one at a time and both keep their words", async () => {
    const { server } = fakeServer();
    const ann = box(server, "ann~1");
    const cam = box(server, "cam~1");
    // Each sees the other's row, still outside the draft, carrying its own words.
    const annOut = { user_id: "ann", user_name: "Ann", user_color: "#000", draft_text: "ship the auth fix" };
    const camOut = { user_id: "cam", user_name: "Cam", user_color: "#000", draft_text: "check the mobile build" };
    expect(waitsToJoin([camOut], "ann", "ship the auth fix")).toBe(false);
    expect(waitsToJoin([annOut], "cam", "check the mobile build")).toBe(true);
    // Ann goes first; her join resolves once her words are on the server.
    expect(await ann.s.join(() => "ship the auth fix", { seed: true, othersLive: () => othersWriting([camOut]) })).toBe("ship the auth fix");
    // Her row now reports she is in the draft (and carries no words of its own): Cam may join, and finds hers.
    const annIn = { user_id: "ann", user_name: "Ann", user_color: "#000", in_draft: true };
    expect(waitsToJoin([annIn], "cam", "check the mobile build")).toBe(false);
    expect(await cam.s.join(() => "check the mobile build", { seed: true, othersLive: () => othersWriting([annIn]) })).toBe("ship the auth fix\n\ncheck the mobile build");
    await settle();
    const r = await server.steps("compose:c1", 0);
    ann.s.receive(0, r.steps, r.clientIds);
    expect(ann.s.text).toBe("ship the auth fix\n\ncheck the mobile build");
  });

  it("join resolves only once its words are on the server, so the box that waited on it finds them", async () => {
    const { server, head } = fakeServer();
    const slow: SharedDraftServer = { ...server, submit: (...a) => new Promise((r) => setTimeout(() => r(server.submit(...a)), 20)) };
    const ann = box(slow, "ann~1");
    await ann.s.join(() => "ship the auth fix", { seed: true, othersLive: () => false });
    expect(head()).toBeGreaterThan(0);
  });

  it("a box whose words are in the draft before its row says so keeps them when an owner joins", async () => {
    const { server } = fakeServer();
    const cam = box(server, "cam~1");
    const ann = box(server, "ann~1");
    await cam.s.join(() => "check the mobile build", { seed: true, othersLive: () => false });
    // Cam's in_draft has not reached Ann yet: his row still carries his own words.
    const camOut = { user_id: "cam", user_name: "Cam", user_color: "#000", draft_text: "check the mobile build" };
    expect(inSharedDraft(camOut)).toBe(false);
    expect(await ann.s.join(() => "ship the auth fix", { seed: true, othersLive: () => othersWriting([camOut]) })).toBe("check the mobile build\n\nship the auth fix");
  });

  it("an empty box never waits to join; a row with no words never holds anyone up", () => {
    const annOut = { user_id: "ann", user_name: "Ann", user_color: "#000", draft_text: "ship it" };
    expect(waitsToJoin([annOut], "cam", "   ")).toBe(false);
    expect(waitsToJoin([{ user_id: "ann", user_name: "Ann", user_color: "#000", draft_text: " " }], "cam", "mine")).toBe(false);
    expect(othersWriting([{ user_id: "ann", user_name: "Ann", user_color: "#000" }])).toBe(false);
  });

  it("applies steps it already holds once, whichever answer brings them", async () => {
    const { server } = fakeServer();
    const a = box(server, "ann~1");
    const b = box(server, "cam~1");
    await a.s.join(() => "", { seed: true, othersLive: () => false });
    await b.s.join(() => "", { seed: false, othersLive: () => false });
    a.s.edit("hi");
    await settle();
    const r = await server.steps("compose:c1", 0);
    b.s.receive(0, r.steps, r.clientIds);
    b.s.receive(0, r.steps, r.clientIds);
    expect(b.s.text).toBe("hi");
  });

  it("snapshots a long draft so a late joiner loads one row", async () => {
    const { server, snaps } = fakeServer();
    const a = box(server, "ann~1");
    await a.s.join(() => "", { seed: true, othersLive: () => false });
    // The fake server answers on microtasks, which setImmediate drains with no
    // timer clamp; 220 setTimeout turns cost seconds on a loaded CI runner.
    const drain = () => new Promise((r) => setImmediate(r));
    let t = "";
    for (let i = 0; i < 110; i++) {
      t += "x";
      a.s.edit(t);
      await drain();
    }
    expect(snaps.length).toBeGreaterThan(0);
    const late = box(server, "cam~1");
    expect(await late.s.join(() => "", { seed: false, othersLive: () => true })).toBe(t);
  });

  it("keeps a keystroke the box holds that the session has not been told of yet", async () => {
    // The box takes a key before React commits it and the effect hands it to
    // edit(). A remote step landing in that gap must not write the box back
    // to the text without it.
    const { server } = fakeServer();
    const a = box(server, "ann~1");
    let boxText = "fix the login";
    const shown: string[] = [];
    const b = new SharedDraftSession("compose:c1", "cam~1", server, {
      text: (next) => { boxText = next; shown.push(next); },
      version: () => {},
      remoteEdit: () => {},
      local: () => ({ text: boxText }),
    });
    await a.s.join(() => "fix the login", { seed: true, othersLive: () => false });
    await settle();
    await b.join(() => boxText, { seed: false, othersLive: () => true });
    boxText = "fix the login bug"; // typed into cam's box, not yet passed to edit()
    a.s.edit("please fix the login");
    await settle();
    const r = await server.steps("compose:c1", 0);
    b.receive(0, r.steps, r.clientIds);
    expect(shown.at(-1)).toBe("please fix the login bug");
    for (let i = 0; i < 5; i++) {
      await settle();
      const all = await server.steps("compose:c1", 0);
      a.s.receive(0, all.steps, all.clientIds);
      b.receive(0, all.steps, all.clientIds);
    }
    expect(a.s.text).toBe("please fix the login bug");
  });

  it("keeps a caret in place when someone types before it", async () => {
    const { server } = fakeServer();
    const a = box(server, "ann~1");
    let mapped = -1;
    const b = new SharedDraftSession("compose:c1", "cam~1", server, {
      text: (_next, map) => { mapped = map(5); },
      version: () => {},
      remoteEdit: () => {},
    });
    await a.s.join(() => "hello world", { seed: true, othersLive: () => false });
    await settle();
    await b.join(() => "", { seed: false, othersLive: () => true });
    a.s.edit(">> hello world");
    await settle();
    const r = await server.steps("compose:c1", 0);
    b.receive(0, r.steps, r.clientIds);
    expect(mapped).toBe(8);
  });
});
