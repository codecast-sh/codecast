/**
 * The desktop pane as a browser target: the registry the app writes, which
 * pane a session may drive, what happens when the human closes it, and the
 * engine binding that follows it. File-backed, so each test runs against its
 * own CODECAST_DIR (like bridge/real.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  desktopPanePins, desktopPaneRegistryPath, findDesktopPane, liveDesktopPaneRegistry, liveDesktopPanes, paneOwnerIds, parseDesktopPaneRegistry,
  readDesktopPaneRegistry, type DesktopPaneRegistry, type LiveDesktopPane,
} from "./desktopPaneRegistry.js";
import { desktopPaneCtx, DesktopPaneUnavailable, ownedDesktopPane, resolveDesktopPane } from "./desktopPane.js";
import { explicitTarget, isPaneMode, isRealMode, rememberedDesktopPane, setStickyTarget, splitTargetFlags, stickyTarget } from "./bridge/real.js";
import { baseSessionKey, engineSessionKey, isPaneSession, isRealSession, paneSessionKey, realSessionKey } from "./engine.js";
import { readBoundTarget } from "./pinnedTab.js";
import type { CdpTarget } from "./cdp.js";

const UUID = "509b4b48-c521-4352-bf19-eafa153745bb";
const OWNER = `session:${UUID}`;

let dir: string;
let prevEnv: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-pane-test-"));
  prevEnv = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

const doc = (over: Partial<DesktopPaneRegistry> = {}): DesktopPaneRegistry => ({
  version: 1,
  port: 9444,
  pid: process.pid,
  updatedAt: 1000,
  panes: [{ paneId: ":r1:", targetId: "PANE1", url: "https://example.com/", session: UUID }],
  ...over,
});

function writeRegistry(reg: DesktopPaneRegistry | string): string {
  const file = desktopPaneRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof reg === "string" ? reg : JSON.stringify(reg));
  return file;
}

const targets = (...ids: Array<[string, string]>): CdpTarget[] => ids.map(([targetId, url]) => ({ targetId, type: "page", title: "", url }));

describe("engine session keys", () => {
  test("the pane is a third mode on the same base key, and every mode reads back", () => {
    const base = engineSessionKey(OWNER);
    expect(isPaneSession(paneSessionKey(base))).toBe(true);
    expect(isRealSession(paneSessionKey(base))).toBe(false);
    expect(baseSessionKey(paneSessionKey(base))).toBe(base);
    expect(baseSessionKey(realSessionKey(base))).toBe(base);
    // Switching modes never stacks suffixes.
    expect(realSessionKey(paneSessionKey(base))).toBe(realSessionKey(base));
    expect(paneSessionKey(realSessionKey(base))).toBe(paneSessionKey(base));
    expect(paneSessionKey(paneSessionKey(base))).toBe(paneSessionKey(base));
  });
});

describe("the registry the app writes", () => {
  test("parses the document the app writes, and nothing it did not", () => {
    expect(parseDesktopPaneRegistry(JSON.stringify(doc()))).toEqual(doc());
    expect(parseDesktopPaneRegistry("not json")).toBeNull();
    expect(parseDesktopPaneRegistry(JSON.stringify({ ...doc(), version: 2 }))).toBeNull();
    expect(parseDesktopPaneRegistry(JSON.stringify({ ...doc(), port: "nope" }))).toBeNull();
    // A pane with no target yet and no session is still a pane.
    const bare = parseDesktopPaneRegistry(JSON.stringify({ ...doc(), pid: undefined, panes: [{ paneId: "x" }, { nope: 1 }] }));
    expect(bare?.pid).toBeNull();
    expect(bare?.panes).toEqual([{ paneId: "x", targetId: null, url: null, session: null }]);
  });

  test("reads from the CLI's own browser dir, and a file left by a dead app is not live", () => {
    expect(readDesktopPaneRegistry()).toBeNull();
    writeRegistry(doc());
    expect(readDesktopPaneRegistry()?.port).toBe(9444);
    expect(liveDesktopPaneRegistry()?.port).toBe(9444);
    expect(liveDesktopPaneRegistry(undefined, () => false)).toBeNull();
    // An older writer that named no pid is taken at its word.
    writeRegistry(doc({ pid: null }));
    expect(liveDesktopPaneRegistry(undefined, () => false)?.port).toBe(9444);
  });

  test("owner ids: the session uuid behind the owner key and the harness ids, never the tmux pane", () => {
    expect(paneOwnerIds(OWNER, {})).toEqual([UUID]);
    expect(paneOwnerIds(`env:${UUID}`, {})).toEqual([UUID]);
    expect(paneOwnerIds("pane:%7", {})).toEqual([]);
    expect(paneOwnerIds(null, { CLAUDE_CODE_SESSION_ID: "abc", CAST_SESSION_ID: "abc" })).toEqual(["abc"]);
    expect(paneOwnerIds(OWNER, { CODEX_SESSION_ID: "xyz" })).toEqual([UUID, "xyz"]);
  });

  test("a session gets the newest pane opened for it; a pane nobody offered belongs to no one", () => {
    const panes = [
      { paneId: "a", targetId: "TA", url: null, session: UUID },
      { paneId: "b", targetId: "TB", url: null, session: null },
      { paneId: "c", targetId: "TC", url: null, session: UUID },
      { paneId: "d", targetId: "TD", url: null, session: "someone-else" },
    ];
    expect(findDesktopPane(panes, [UUID])?.paneId).toBe("c");
    expect(findDesktopPane(panes, ["nobody"])).toBeNull();
    expect(findDesktopPane(panes, [])).toBeNull();
    expect(findDesktopPane(panes, [], "b")?.paneId).toBe("b");
    expect(findDesktopPane(panes, [UUID], "zzz")).toBeNull();
  });

  test("live panes are the ones the app's port still lists; a view with no id is matched by url once", async () => {
    const reg = doc({
      panes: [
        { paneId: "a", targetId: "TA", url: "https://a/", session: UUID },
        { paneId: "gone", targetId: "TGONE", url: "https://gone/", session: UUID },
        { paneId: "noid", targetId: null, url: "https://n/", session: UUID },
        { paneId: "noid2", targetId: null, url: "https://n/", session: UUID },
      ],
    });
    const list = async () => targets(["TA", "https://a/"], ["TN", "https://n/"], ["MAIN", "http://localhost:3200/"]);
    const live = await liveDesktopPanes(reg, list);
    expect(live.map((p) => [p.paneId, p.targetId])).toEqual([
      ["a", "TA"],
      ["noid", "TN"],
    ]);
  });

  test("pins for the watch engine: the endpoint and the target ids the registry vouches for, off the file alone", () => {
    expect(desktopPanePins()).toBeNull();
    writeRegistry(doc({ panes: [...doc().panes, { paneId: "x", targetId: null, url: null, session: null }] }));
    expect(desktopPanePins()).toEqual({ endpoint: 9444, targets: new Set(["PANE1"]) });
  });
});

describe("sticky target: pane", () => {
  test("`target pane` sticks per session, --real overrides it for one verb, and --pane asks for one verb", () => {
    expect(stickyTarget(OWNER)).toBe("real");
    expect(isPaneMode({}, OWNER)).toBe(false);
    setStickyTarget(OWNER, "pane");
    expect(stickyTarget(OWNER)).toBe("pane");
    expect(explicitTarget(OWNER)).toBe("pane");
    expect(isPaneMode({}, OWNER)).toBe(true);
    expect(isRealMode({}, OWNER)).toBe(false);
    // Settling real mode must not clobber a chosen pane.
    expect(stickyTarget(OWNER, { settle: true })).toBe("pane");
    expect(isPaneMode({ real: true }, OWNER)).toBe(false);
    expect(isRealMode({ real: true }, OWNER)).toBe(true);
    // Another session is untouched.
    expect(isPaneMode({}, "session:other")).toBe(false);
    expect(isPaneMode({ pane: true }, "session:other")).toBe(true);
    expect(isRealMode({ pane: true }, "session:other")).toBe(false);
    setStickyTarget(OWNER, "real");
    expect(stickyTarget(OWNER)).toBe("real");
  });

  test("--pane comes off a raw argument line like --real", () => {
    expect(splitTargetFlags(["open", "--pane", "https://x"])).toEqual({ real: undefined, clone: undefined, pane: true, args: ["open", "https://x"] });
  });
});

describe("resolveDesktopPane", () => {
  const live = async (reg: DesktopPaneRegistry): Promise<LiveDesktopPane[]> =>
    reg.panes.filter((p): p is LiveDesktopPane => !!p.targetId);

  test("no app: the registry is missing, and the agent is told what that means", async () => {
    await expect(resolveDesktopPane(OWNER, {}, { live })).rejects.toMatchObject({ reason: "no-app" });
  });

  test("no pane: the session never had one, and the only move is to offer one", async () => {
    writeRegistry(doc({ panes: [] }));
    const err = await resolveDesktopPane(OWNER, {}, { live, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(DesktopPaneUnavailable);
    expect(err.reason).toBe("no-pane");
    expect(err.message).toContain("cast browser pane <url>");
    expect(err.message).toContain("never opens a pane itself");
    expect(rememberedDesktopPane(OWNER)).toBeNull();
  });

  test("owned: the session's pane, remembered for later", async () => {
    writeRegistry(doc());
    const r = await resolveDesktopPane(OWNER, {}, { live, env: {} });
    expect(r.pane.targetId).toBe("PANE1");
    expect(r.registry.port).toBe(9444);
    expect(rememberedDesktopPane(OWNER)).toBe(":r1:");
    expect((await ownedDesktopPane(OWNER, { live, env: {} }))?.pane.paneId).toBe(":r1:");
  });

  test("closed: said once, the sticky choice drops back to the human's Chrome, then it is 'no pane'", async () => {
    writeRegistry(doc());
    setStickyTarget(OWNER, "pane");
    await resolveDesktopPane(OWNER, {}, { live, env: {} });
    // The human closed it: the app rewrote the file without it.
    writeRegistry(doc({ panes: [] }));
    const first = await resolveDesktopPane(OWNER, {}, { live, env: {} }).catch((e) => e);
    expect(first.reason).toBe("closed");
    expect(first.message).toBe("the pane was closed");
    expect(explicitTarget(OWNER)).toBe("real");
    expect(rememberedDesktopPane(OWNER)).toBeNull();
    const second = await resolveDesktopPane(OWNER, {}, { live, env: {} }).catch((e) => e);
    expect(second.reason).toBe("no-pane");
  });

  test("closed while the pane was asked for per verb: reported, but nobody's sticky choice changes", async () => {
    writeRegistry(doc());
    await resolveDesktopPane(OWNER, {}, { live, env: {} });
    writeRegistry(doc({ panes: [] }));
    const err = await resolveDesktopPane(OWNER, {}, { live, env: {} }).catch((e) => e);
    expect(err.reason).toBe("closed");
    expect(explicitTarget(OWNER)).toBeNull();
  });

  test("the port not answering is 'no app', not 'no pane'", async () => {
    writeRegistry(doc());
    const err = await resolveDesktopPane(OWNER, {}, { live: async () => { throw new Error("ECONNREFUSED"); }, env: {} }).catch((e) => e);
    expect(err.reason).toBe("no-app");
    expect(err.message).toContain("9444");
  });
});

describe("desktopPaneCtx", () => {
  const live = async (reg: DesktopPaneRegistry): Promise<LiveDesktopPane[]> =>
    reg.panes.filter((p): p is LiveDesktopPane => !!p.targetId);

  test("a -pane engine session on the app's socket, pinned to the pane's target; a changed target detaches the old daemon first", async () => {
    writeRegistry(doc());
    const stateDir = path.join(dir, "engine");
    const detached: string[] = [];
    const socket = async (port: number) => `ws://127.0.0.1:${port}/devtools/browser/abc`;
    const ctx = await desktopPaneCtx(OWNER, {}, { live, env: {}, stateDir, socket, detach: (s) => (detached.push(s), true) });
    expect(ctx.session).toBe(paneSessionKey(engineSessionKey(OWNER)));
    expect(ctx.cdp).toBe("ws://127.0.0.1:9444/devtools/browser/abc");
    expect(readBoundTarget(ctx.session, stateDir)).toBe("PANE1");
    expect(detached).toEqual([]);

    // A fresh offer, opened after the first pane closed: a new target under
    // the same key. No daemon is running in this test, so nothing to detach,
    // but the binding must follow.
    writeRegistry(doc({ panes: [{ paneId: ":r2:", targetId: "PANE2", url: "https://example.org/", session: UUID }] }));
    const again = await desktopPaneCtx(OWNER, {}, { live, env: {}, stateDir, socket, detach: (s) => (detached.push(s), true) });
    expect(readBoundTarget(again.session, stateDir)).toBe("PANE2");
    // With a live daemon it is detached before the rewrite.
    fs.writeFileSync(path.join(stateDir, `${again.session}.pid`), String(process.pid));
    writeRegistry(doc({ panes: [{ paneId: ":r3:", targetId: "PANE3", url: "https://example.org/", session: UUID }] }));
    await desktopPaneCtx(OWNER, {}, { live, env: {}, stateDir, socket, detach: (s) => (detached.push(s), true) });
    expect(detached).toEqual([again.session]);
    expect(readBoundTarget(again.session, stateDir)).toBe("PANE3");
  });

  test("a keyless caller drives the default session's pane by explicit id only", async () => {
    writeRegistry(doc({ panes: [{ paneId: "hand", targetId: "T", url: null, session: null }] }));
    const stateDir = path.join(dir, "engine");
    const socket = async () => "ws://x";
    await expect(desktopPaneCtx(null, {}, { live, env: {}, stateDir, socket })).rejects.toMatchObject({ reason: "no-pane" });
    const ctx = await desktopPaneCtx(null, { pane: "hand" }, { live, env: {}, stateDir, socket });
    expect(ctx.session).toBe(paneSessionKey("default"));
    expect(readBoundTarget(ctx.session, stateDir)).toBe("T");
  });
});
