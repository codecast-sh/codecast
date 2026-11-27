// A daemon restart keeps beating the sessions the last daemon parked. Without
// it a parked Ship subject stopped beating, its run wake lapsed, and the inbox
// filed it under Needs You while the run was still live (ct-102132).
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreHibernationParks, sessionParkStateForTests, trackSessionPaneForTests } from "./daemon.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "park-restore-"));
const file = path.join(dir, "parked-sessions.json");
afterEach(() => {
  for (const id of ["restore-parked", "restore-live"]) trackSessionPaneForTests(id, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

test("a session parked before the restart beats as hibernated after it", () => {
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ "restore-parked": now - 60_000 }));
  expect(sessionParkStateForTests("restore-parked").beating).toBe(false);

  expect(restoreHibernationParks(file, now)).toEqual(["restore-parked"]);
  expect(sessionParkStateForTests("restore-parked")).toEqual({ parked: true, beating: true, paneTracked: false, status: "hibernated" });
});

test("a session that already has a pane again is not restored as parked", () => {
  const now = Date.now();
  trackSessionPaneForTests("restore-live", "cc-resume-live", { status: "idle" });
  fs.writeFileSync(file, JSON.stringify({ "restore-live": now - 60_000 }));

  expect(restoreHibernationParks(file, now)).toEqual([]);
  expect(sessionParkStateForTests("restore-live")).toMatchObject({ parked: false, status: "idle" });
});
