/**
 * Ordinals and stale-ref recovery against a real renderer.
 *
 * The failure this guards is silent: a list re-renders between the snapshot
 * and the click, the ref is detached, and a recovery that matches on role and
 * name alone lands on the FIRST row named "Delete" — reporting success while
 * deleting the wrong thing. So the test does the whole round trip on a real
 * page: snapshot, re-render, recover, click, and read back which row the page
 * says was clicked.
 *
 * Skipped where Chrome is absent (CI runners); the pure functions in
 * refMemory.test.ts and snapshot.test.ts carry the regression weight there.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as actions from "./actions.js";
import { CdpConnection } from "./cdp.js";
import { attachToTarget, type PageSession } from "./instance.js";
import { recoverRefPlan, type SnapshotRefEntry } from "./refMemory.js";
import { matchRefs, pickOrdinal, snapshotPage, splitOrdinalQuery, type SnapshotRef } from "./snapshot.js";
import { findChromeBinary } from "../workspace/chrome.js";

const chrome = findChromeBinary();
const FIXTURE = path.join(import.meta.dir, "fixtures", "rerendering-list.html");

/** The engine and the legacy driver spell a ref differently; recovery works on
 *  the string form, so the test hands it what a snapshot knows. */
const asEntries = (refs: SnapshotRef[]): SnapshotRefEntry[] =>
  refs.map((r) => ({ ref: String(r.ref), role: r.role, name: r.name, nth: r.nth }));

describe.skipIf(!chrome)("ordinals and stale refs in a real page", () => {
  let server: http.Server;
  let proc: ChildProcess;
  let conn: CdpConnection;
  let page: PageSession;
  let userDataDir: string;

  const evalPage = async (expression: string): Promise<unknown> =>
    (await page.conn.send<any>("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId)).result?.value;

  const deletes = async (): Promise<SnapshotRef[]> =>
    (await snapshotPage(page, { interactiveOnly: true })).refs.filter((r) => r.name === "Delete");

  beforeAll(async () => {
    const html = fs.readFileSync(FIXTURE, "utf-8");
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-ordinals-"));
    proc = spawn(
      chrome!,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    const portFile = path.join(userDataDir, "DevToolsActivePort");
    let port = 0;
    for (let i = 0; i < 200 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const first = fs.readFileSync(portFile, "utf-8").split("\n")[0];
        if (first) port = parseInt(first, 10);
      } catch {
        /* not up yet */
      }
    }
    if (!port) throw new Error("headless Chrome never reported a debugging port");

    conn = await CdpConnection.fromPort(port);
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url });
    page = await attachToTarget(conn, targetId);
    await conn.send("Page.navigate", { url }, page.sessionId);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if ((await evalPage("document.readyState")) === "complete") break;
    }
  }, 60_000);

  afterAll(async () => {
    conn?.close();
    proc?.kill();
    await new Promise<void>((r) => server?.close(() => r()));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test("three rows named alike print their position", async () => {
    const snap = await snapshotPage(page, { interactiveOnly: true });
    expect(snap.refs.filter((r) => r.name === "Delete").map((r) => r.nth)).toEqual([1, 2, 3]);
    expect(snap.text).toMatch(/button "Delete" #e\d+/);
    expect(snap.text).toMatch(/button "Delete \(2nd\)" #e\d+/);
    expect(snap.text).toMatch(/button "Delete \(3rd\)" #e\d+/);
  });

  test("an ordinal in the query picks that row, and it is the row that fires", async () => {
    await evalPage("document.getElementById('log').textContent = ''");
    const snap = await snapshotPage(page, { interactiveOnly: true });
    const { text, nth } = splitOrdinalQuery("Delete (3rd)");
    const [hit] = pickOrdinal(snap.refs, matchRefs(snap.refs, text), nth!);
    await actions.click(page, hit.ref);
    expect(await evalPage("document.getElementById('log').textContent")).toBe("deleted Gamma");
  });

  test("a ref that the re-render detached recovers onto the same row", async () => {
    const before = await deletes();
    const wanted = before[2]; // Gamma's Delete
    expect(wanted.nth).toBe(3);

    await evalPage("window.rerender(); document.getElementById('log').textContent = ''");

    // Every row node is new, so the ref the agent held is dead.
    const after = await deletes();
    expect(after.map((r) => r.ref)).not.toContain(wanted.ref);
    await expect(actions.click(page, wanted.ref)).rejects.toThrow();

    const fresh = recoverRefPlan({ role: wanted.role, name: wanted.name, nth: wanted.nth }, asEntries(after));
    // Matching on role and name alone would have answered the first row here.
    expect(fresh).not.toBe(String(after[0].ref));
    await actions.click(page, Number(fresh));
    expect(await evalPage("document.getElementById('log').textContent")).toBe("deleted Gamma");
  });
});
