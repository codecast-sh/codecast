// The run page's fixture: one rep of each kind the page must draw, read from
// the fixture world exactly as the api child would answer, with its freeze.
// RunView and CompareView take these as props in the mount test.
//
//   call     settle, a pass in the newest epoch (so its prompts diff against the one before)
//   gate     a call rep that failed its no-leak gate
//   agent    role-wake, a rep that read the live workspace
//   crash    a rep that crashed before replying
//   dry      a dry render: never scored, so the rubric shows
//   org      org-review, with grade-auto.json and hashes.json
//   compare  settle's broken freeze, the last pass before the regression against the first fail after it

import type { CompareResponse, FreezeResponse, RunResponse, RunRow } from "@codecast/shared/contracts/evalsApi";
import { evalsFixtureWorld } from "./world";

export interface RunFixtureCase {
  run: RunResponse;
  freeze: FreezeResponse;
}

export interface RunFixture {
  call: RunFixtureCase;
  gate: RunFixtureCase;
  agent: RunFixtureCase;
  crash: RunFixtureCase;
  dry: RunFixtureCase;
  org: RunFixtureCase;
  compare: CompareResponse;
}

export function runFixture(now = Date.parse("2026-10-03T12:00:00.000Z")): RunFixture {
  const world = evalsFixtureWorld({ now });
  const one = (row: RunRow | undefined, what: string): RunFixtureCase => {
    if (!row) throw new Error(`the fixture world has no ${what}`);
    return {
      run: world.answer("GET /run/:id", { id: row.id }, {}) as RunResponse,
      freeze: world.answer("GET /freeze/:id", { id: row.freezeId }, {}) as FreezeResponse,
    };
  };
  const rows = world.rows;
  const newest = (xs: RunRow[]) => [...xs].sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
  const settle = rows.filter((r) => r.surface === "settle" && r.cadence === "nightly");
  const broken = settle.filter((r) => r.freezeName === "unresolvable-error");
  const lastPass = newest(broken.filter((r) => r.status === "pass" && !r.gatesFailed.length));
  const firstFailAfter = [...broken].sort((a, b) => a.stamp.localeCompare(b.stamp)).find((r) => r.status === "fail" && lastPass && r.stamp > lastPass.stamp);
  return {
    call: one(newest(settle.filter((r) => r.status === "pass" && r.freezeName === "waiting-on-review")), "settle pass"),
    gate: one(newest(rows.filter((r) => r.gatesFailed.includes("no-leak") && r.surface !== "org-review")), "gate failure"),
    agent: one(newest(rows.filter((r) => r.surface === "role-wake" && r.liveReads > 0 && r.guard.live > 0 && r.status !== "crash")), "role-wake rep with live reads"),
    crash: one(newest(rows.filter((r) => r.status === "crash")), "crash"),
    dry: one(newest(rows.filter((r) => r.status === "dry")), "dry render"),
    org: one(newest(rows.filter((r) => r.surface === "org-review" && r.status !== "crash" && r.status !== "dry")), "org-review rep"),
    compare: world.answer("GET /compare", {}, { a: lastPass?.id ?? "", b: firstFailAfter?.id ?? "" }) as CompareResponse,
  };
}
