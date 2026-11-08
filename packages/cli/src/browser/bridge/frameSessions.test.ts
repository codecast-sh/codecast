import { describe, expect, test } from "bun:test";
import { FrameSessions } from "./frameSessions.js";

/** Two clients holding root sessions on tab 7; ids minted in order. */
function rig(opts: { admit?: (url: string) => boolean } = {}) {
  const roots: Array<[string, string]> = [["A", "ROOT-A"], ["B", "ROOT-B"]];
  let n = 0;
  const fs = new FrameSessions<string>({
    rootSessions: (tabId) => (tabId === 7 ? roots : []),
    mint: () => `KID${++n}`,
    admit: (_tabId, url) => opts.admit?.(url) ?? true,
  });
  return { fs, roots };
}
const child = (sessionId: string, url = "https://pay.example/frame", targetId = `T-${sessionId}`) => ({
  sessionId,
  targetInfo: { targetId, type: "iframe", url, browserContextId: "REAL" },
  waitingForDebugger: false,
});

describe("FrameSessions", () => {
  test("a child reaches only clients that asked for auto-attach on the parent, under a minted id", () => {
    const { fs } = rig();
    expect(fs.setAutoAttach("A", "ROOT-A", 7, null, true)).toEqual([]);
    const out = fs.attached(7, null, child("CHROME1"));
    expect(out).toHaveLength(1);
    expect(out[0].client).toBe("A");
    expect(out[0].msg).toMatchObject({ method: "Target.attachedToTarget", sessionId: "ROOT-A", params: { sessionId: "KID1", waitingForDebugger: false } });
    expect(JSON.stringify(out)).not.toContain('"CHROME1"');
    // Chrome's real context id stays behind too, as for the tab's own target info.
    expect((out[0].msg.params as any).targetInfo.browserContextId).toBe("cast-real-chrome");
    expect(fs.route("A", "KID1")).toEqual({ tabId: 7, chrome: "CHROME1", parent: "ROOT-A" });
    expect(fs.route("B", "KID1")).toBeUndefined();
  });

  test("setAutoAttach replays children Chrome already reported, once", () => {
    const { fs } = rig();
    fs.attached(7, null, child("CHROME1"));
    const replay = fs.setAutoAttach("B", "ROOT-B", 7, null, true);
    expect(replay.map((o) => [o.client, (o.msg.params as any).sessionId])).toEqual([["B", "KID1"]]);
    expect(fs.setAutoAttach("B", "ROOT-B", 7, null, true)).toEqual([]);
  });

  test("events route to each client's own id; nested children sit under the child", () => {
    const { fs } = rig();
    fs.setAutoAttach("A", "ROOT-A", 7, null, true);
    fs.setAutoAttach("B", "ROOT-B", 7, null, true);
    fs.attached(7, null, child("CHROME1"));
    expect(fs.eventTargets(7, "CHROME1")).toEqual([["A", "KID1"], ["B", "KID2"]]);
    // A grandchild is offered only below a child session that asked.
    expect(fs.attached(7, "CHROME1", child("CHROME2"))).toEqual([]);
    const nested = fs.setAutoAttach("A", "KID1", 7, "CHROME1", true);
    expect(nested[0].msg).toMatchObject({ sessionId: "KID1", params: { sessionId: "KID3" } });
  });

  test("a frame the site policy refuses is never offered", () => {
    const { fs } = rig({ admit: (url) => !url.includes("blocked") });
    fs.setAutoAttach("A", "ROOT-A", 7, null, true);
    expect(fs.attached(7, null, child("CHROME1", "https://blocked.example/"))).toEqual([]);
    expect(fs.attached(7, null, child("CHROME2", "https://ok.example/"))).toHaveLength(1);
  });

  test("Chrome's detach removes the child and its children, telling each holder on the parent's session", () => {
    const { fs } = rig();
    fs.setAutoAttach("A", "ROOT-A", 7, null, true);
    fs.attached(7, null, child("CHROME1"));
    fs.setAutoAttach("A", "KID1", 7, "CHROME1", true);
    fs.attached(7, "CHROME1", child("CHROME2"));
    const out = fs.detached(7, "CHROME1");
    // The grandchild's parent leaves too, so only the child's detach is sent.
    expect(out.map((o) => o.msg)).toEqual([{ method: "Target.detachedFromTarget", params: { sessionId: "KID1", targetId: "T-CHROME1" }, sessionId: "ROOT-A" }]);
    expect(fs.route("A", "KID1")).toBeUndefined();
    expect(fs.route("A", "KID2")).toBeUndefined();
    expect(fs.eventTargets(7, "CHROME2")).toEqual([]);
  });

  test("dropTab detaches every child on the tab; dropSession drops a client's subtree silently", () => {
    const { fs } = rig();
    fs.setAutoAttach("A", "ROOT-A", 7, null, true);
    fs.setAutoAttach("B", "ROOT-B", 7, null, true);
    fs.attached(7, null, child("CHROME1"));
    fs.dropSession("A", "ROOT-A");
    expect(fs.route("A", "KID1")).toBeUndefined();
    expect(fs.route("B", "KID2")).toBeDefined();
    const out = fs.dropTab(7);
    expect(out.map((o) => o.client)).toEqual(["B"]);
    // Nothing left to replay after the tab's session ended.
    expect(fs.setAutoAttach("A", "ROOT-A", 7, null, true)).toEqual([]);
  });

  test("a child refused at attach is offered once it navigates onto an allowed site", () => {
    const { fs } = rig({ admit: (url) => url.startsWith("https://ok.") });
    fs.setAutoAttach("A", "ROOT-A", 7, null, true);
    expect(fs.attached(7, null, child("CHROME1", "https://blocked.example/"))).toEqual([]);
    const out = fs.navigated(7, "CHROME1", "https://ok.example/");
    expect(out.map((o) => (o.msg.params as any).targetInfo.url)).toEqual(["https://ok.example/"]);
    expect(fs.navigated(7, "CHROME1", "https://ok.example/2")).toEqual([]);
  });

  test("a child's own navigation updates the URL its commands are checked against", () => {
    const { fs } = rig();
    fs.setAutoAttach("A", "ROOT-A", 7, null, true);
    fs.attached(7, null, child("CHROME1", "https://a.example/"));
    fs.navigated(7, "CHROME1", "https://b.example/next");
    expect(fs.url(fs.route("A", "KID1")!)).toBe("https://b.example/next");
  });
});
