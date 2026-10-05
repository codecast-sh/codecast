// Part of the fixture world (../world.ts), which every caller imports. The
// Multiplayer sim: its catalog, sessions and failing runs. Nothing here is
// real data.

import type { SimCatalogResponse, SimInvariant, SimRunResponse, SimRunRow, SimScenario, SimSessionSummary } from "@codecast/shared/contracts/evalsApi";
import { makeRng } from "@codecast/shared/random";
import { simGridOf } from "../../../../store/__tests__/sim/grid";
import { simFixtureRun } from "../sim";
import { DAY, type FixtureState, fixtureHex, iso, stampOf } from "./model";

// ── Multiplayer sim ─────────────────────────────────────────────────────────

const SIM_SCENARIOS = ["agentPingPong", "daemonRestartParked", "memberRemovedMidTurn", "personalAnchorOwnedByTeammate", "queuedSendVsLaggingTail", "reapVsFollowerLock", "resumeVsSend", "roleTriggerScope", "twoHumansOneRole", "viewerHideVsOwner", "visibilityFlip"];
const SIM_SELFTESTS = ["dsl", "invariants", "realm", "window", "world"];
const SIM_INVARIANTS: Array<[string, string]> = [
  ["INV-sessions-mine", "the window's mine digest, tally and placements equal the principal's canonical projection"],
  ["INV-followers", "every follower holds the host's replicated slice byte for byte"],
  ["INV-team-inbox", "the team slot holds exactly the server's team list for the viewer, minus the viewer's own hides"],
  ["INV-workspace-rows", "the window holds no task, doc, plan or project its principal cannot read, and each one it feeds matches the server in its workspace"],
  ["INV-sweep", "the team scope sweep finds no work item whose stored workspace key disagrees with its computed one"],
  ["INV-cursors", "each held sync-log scope's cursor stands at its head, and no unheld scope has a cursor"],
  ["INV-pending-locks", "no acknowledged lock survives its cursor, and no field lock outlives the settle window"],
  ["INV-outbox", "every window's engine outbox is empty once the world settles"],
  ["INV-triggers", "the trigger replica equals agentTasks:webList, and each conversation's armed kind matches its live triggers"],
  ["INV-pending-sends", "every send bubble is echoed, settled or failed, and each client_id is on at most one pending_messages row"],
  ["INV-chat", "the chat replica equals chat:listMessages, each mention wakes its target once, and the hourly wake caps hold"],
  ["INV-roles", "each role's mention wake counter equals the wakes enqueued for it, and listAnchors equals visibleAnchorsForUser"],
  ["INV-ping-pong", "agent to agent wakes per virtual hour stay under the mention caps, per sender, per person and per target"],
  ["INV-row-shape", "every sessions row holds only the inbox row's fields (INBOX_ROW_FIELDS plus the facts), or a field a pending local write holds"],
  ["INV-fixpoint", "re-running every mounted feeder, one catch-up and a byIds pass over every held id changes nothing"],
];

const failureInvariant = (r: SimRunResponse) => (r.result.passed === true ? "" : r.result.invariant.id);

export function buildSim(now: number): FixtureState["sim"] {
  const rand = makeRng(7);
  const invariants: SimInvariant[] = SIM_INVARIANTS.map(([id, meaning]) => ({ id, meaning, keys: [] }));
  const head = fixtureHex("commit:19:suggest: voice from recent sends");
  const sessions: SimSessionSummary[] = [];
  const runs = new Map<string, SimRunResponse>();
  const allRows: Array<{ session: string; at: number; row: SimRunRow }> = [];
  for (let i = 0; i < 9; i++) {
    const at = now - (8 - i) * DAY * 0.9 - 3_600_000;
    const id = stampOf(at);
    const rows: SimRunRow[] = [];
    for (const scenario of SIM_SCENARIOS) {
      for (const mode of ["scripted", "interleave"] as const) {
        const seeds = mode === "interleave" ? 4 : 1;
        for (let seed = 1; seed <= seeds; seed++) {
          const fails = scenario === "memberRemovedMidTurn" && mode === "interleave" && seed === 3 && i >= 6;
          const row: SimRunRow = { scenario, mode, seed, passed: !fails, deliveries: 20 + Math.floor(rand() * 40), ms: 300 + Math.floor(rand() * 900), ...(fails ? { dir: `${scenario}-${mode}-${seed}` } : {}) };
          rows.push(row);
          allRows.push({ session: id, at, row });
        }
      }
    }
    const failed = rows.filter((r) => !r.passed).length;
    const failing = rows.filter((r) => !r.passed).map(({ scenario, mode, seed, dir }) => ({ scenario, mode, seed, ...(dir ? { dir } : {}) }));
    sessions.push({ id, argv: i === 8 ? ["memberRemovedMidTurn", "--sweep", "4"] : [], gitHead: head, dirty: i >= 7, treePatch: i >= 7 ? fixtureHex(`simpatch:${id}`, 64) : null, startedAt: iso(at), finishedAt: iso(at + 95_000), exit: failed ? 1 : 0, runs: rows.length, failed, scenarios: SIM_SCENARIOS.length, failing });
  }
  sessions.push({ id: "codecast-sim-legacy-1", argv: [], gitHead: null, dirty: false, treePatch: null, startedAt: iso(now - 12 * DAY), finishedAt: null, exit: null, unsessioned: true, runs: 1, failed: 1, scenarios: 1, failing: [{ scenario: "memberRemovedMidTurn", mode: "interleave", seed: 1 }] });

  // Every failing run is the same story (__fixtures__/sim.ts); the newest one has been shrunk.
  const failing = allRows.filter((r) => !r.row.passed);
  failing.forEach(({ session, row }, k) => {
    const run = simFixtureRun({ session: sessions.find((s) => s.id === session)!, run: row, gitHead: head, shrunk: k === failing.length - 1 });
    row.deliveries = run.run.deliveries;
    runs.set(`${session}/${row.dir}`, run);
  });

  const scenarios: SimScenario[] = [
    ...SIM_SCENARIOS.map((name) => ({ name, file: `scenarios/${name}.scenario.ts`, selftest: false, modes: ["scripted", "interleave"], red: name === "roleTriggerScope" ? [{ task: "ct-55120", invariant: "INV-triggers", modes: ["interleave"], seeds: null }] : [], known: name === "visibilityFlip" ? [{ invariant: "INV-sweep", tasks: ["ct-54902"] }] : [] })),
    ...SIM_SELFTESTS.map((name) => ({ name, file: `selftests/${name}.selftest.ts`, selftest: true, modes: ["scripted"], red: [], known: [] })),
  ];
  const catalog: SimCatalogResponse = {
    gitHead: head,
    scenarios,
    invariants,
    notCompared: [
      { key: "conversations", reason: "the message page's meta twin, fed only by a conversation page the sim does not open" },
      { key: "capabilityBindings", reason: "fed by useSyncCapabilityState, a bespoke hook the sim does not mount" },
      { key: "buckets", reason: "fed by useSyncBuckets, a bespoke hook the sim does not mount" },
      { key: "chatReads", reason: "per-viewer read marks fed by useChatSync, which the sim does not mount" },
      { key: "chatRail", reason: "a client fold over chat rows, derived at read time" },
    ],
    // The child's own fold over the same history (store/__tests__/sim/grid.ts).
    ...simGridOf(
      scenarios,
      [...sessions].reverse().filter((s) => !s.unsessioned).map((session) => ({ session, runs: allRows.filter((r) => r.session === session.id).map((r) => r.row) })),
      (session, dir) => {
        const run = runs.get(`${session}/${dir}`);
        return run ? failureInvariant(run) || null : null;
      },
    ),
  };
  return { catalog, sessions: sessions.reverse(), runs };
}
