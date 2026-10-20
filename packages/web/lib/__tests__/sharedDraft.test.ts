import { describe, expect, it } from "bun:test";
import { joinPlan, joinedText, textEdit, SharedDraftSession, type SharedDraftServer } from "../sharedDraft";

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
