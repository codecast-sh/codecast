// One Multiplayer sim failure, shaped like a real artifact folder
// (store/__tests__/sim/report.ts writeArtifacts): deliveries in delivery order
// with their enqueue seqs out of order, actor steps carrying their delivery's
// seq and settles and checks at seq 0, a space separated order, and the replay
// lines as replayCommands prints them. The world fixture builds its failing
// runs from this, so the page in the browser and its tests read the same run.
//
// The story: Ada sends a turn from her laptop, Bo (an admin) removes her from
// the team mid-turn, her phone closes, and the laptop's follower window keeps
// the session in its team slot after the world settles.

import type { SimEvent, SimFailureResult, SimMinimal, SimRunResponse, SimRunRow, SimSession, SimShrinkProgress, SimWorld } from "@codecast/shared/contracts/evalsApi";
import { bisectCommand, formatOrder, replayCommands } from "../../../store/__tests__/sim/replay";

type Line = ["step", string, string, string] | [string, string, string];

const LH = "laptop-host";
const LF = "laptop-follower";
const PH = "phone-host";

/** The run in delivery order: a step row is ["step", verb, actor, label]; a delivery is [channel, label, producer]. */
const SCRIPT: Line[] = [
  [`live:${LH}:inbox`, "push conversations:listInboxSessions", `${LH} inbox`],
  [`live:${LH}:decisions`, "push sessionDecisions:listForUser", `${LH} decisions`],
  [`conn:${LH}`, "req query syncLog:getHeads", `${LH} syncLog:getHeads`],
  [`conn:${LH}`, "res syncLog:getHeads", `${LH} syncLog:getHeads`],
  [`repl:${LH}>${LF}`, "slice sessions ada/s", `${LH} replicate`],
  [`live:${PH}:inbox`, "push conversations:listInboxSessions", `${PH} inbox`],
  [`conn:${PH}`, "req query conversations:listInboxSessionsPaginated", `${PH} conversations:listInboxSessionsPaginated`],
  [`bridge:laptop:daemon`, "daemon heartbeat", "laptop daemon"],
  [`conn:${PH}`, "res conversations:listInboxSessionsPaginated", `${PH} conversations:listInboxSessionsPaginated`],
  ["sched", "sched agentTasks:generateDisplaySummary", "sched agentTasks:generateDisplaySummary"],
  ["step", "settle", "world", "settle #1"],
  [`live:${LH}:team`, "push conversations:listTeamInboxSessions", `${LH} team`],
  [`repl:${LH}>${LF}`, "slice team acme", `${LH} replicate`],
  ["step", "send", LH, "send a turn on ada/s"],
  [`actor:${LH}`, `${LH} send ada/s`, `actor:${LH} send`],
  [`conn:${LH}`, "req mutation messages:send", `${LH} messages:send`],
  [`conn:${LH}`, "res messages:send", `${LH} messages:send`],
  [`live:${LH}:inbox`, "push conversations:listInboxSessions", `${LH} inbox`],
  [`repl:${LH}>${LF}`, "slice pending ada/s", `${LH} replicate`],
  ["step", "remove", "bo.admin", "remove acme ada"],
  ["actor:bo.admin", "bo.admin remove acme ada", "actor:bo.admin remove"],
  ["sched", "sched teamActivity:recordTeamActivity", "sched teamActivity:recordTeamActivity"],
  [`live:${PH}:team`, "push conversations:listTeamInboxSessions", `${PH} team`],
  ["step", "close", PH, "close phone-host"],
  [`actor:${PH}`, `${PH} close`, `actor:${PH} close`],
  [`live:${LH}:team`, "push conversations:listTeamInboxSessions", `${LH} team`],
  [`bridge:laptop:daemon`, "daemon resync acme", "laptop daemon"],
  [`conn:${LH}`, "req query syncLog:getRange", `${LH} syncLog:getRange`],
  [`conn:${LH}`, "res syncLog:getRange", `${LH} syncLog:getRange`],
  [`live:${LH}:heads`, "push syncLog:getHeads", `${LH} heads`],
  [`timer:${LH}`, "setTimeout(flushApplyTally, 60000)", `${LH} setTimeout(flushApplyTally, 60000)`],
  ["step", "settle", "world", "settle #2"],
  [`conn:${LH}`, "req query conversations:getInboxSessionsByIds", `${LH} conversations:getInboxSessionsByIds`],
  [`conn:${LH}`, "res conversations:getInboxSessionsByIds", `${LH} conversations:getInboxSessionsByIds`],
  [`live:${LH}:liveness`, "push conversations:sessionsLiveness", `${LH} liveness`],
  [`timer:${LF}`, "setTimeout(settleLocks, 1500)", `${LF} setTimeout(settleLocks, 1500)`],
  [`conn:${LH}`, "req query tasks:webList", `${LH} tasks:webList`],
  [`conn:${LH}`, "res tasks:webList", `${LH} tasks:webList`],
  [`repl:${LH}>${LF}`, "slice liveness", `${LH} replicate`],
  [`live:${LH}:team`, "push conversations:listTeamInboxSessions", `${LH} team`],
];

/** The deliveries a shrink keeps: the send, the removal and the team pushes and slices around them. */
const KEPT = [4, 12, 13, 14, 15, 17, 18, 20, 23, 30, 34];

export const SIM_FIXTURE_LABELS: Record<string, string> = {
  useradaz700000000000000000000000: "ada",
  userboz6000000000000000000000000: "bo",
  teamacmez80000000000000000000000: "acme",
  sessionadasz11000000000000000000: "ada/s",
  pendingmsg1z11000000000000000000: "pending_messages#1",
};

/** The row the failure names: its label is the trace line's. */
const ROW_ID = "sessionadasz11000000000000000000";

const INVARIANT = { id: "INV-followers", meaning: "every follower holds the host's replicated slice byte for byte" };

function eventsOf(): SimEvent[] {
  const deliveries = SCRIPT.filter((l) => l[0] !== "step").length;
  // Enqueue numbers run ahead of delivery order in places: swap every third pair.
  const seqs = Array.from({ length: deliveries }, (_, i) => i + 1);
  for (let i = 1; i + 1 < seqs.length; i += 3) [seqs[i], seqs[i + 1]] = [seqs[i + 1], seqs[i]];
  const out: SimEvent[] = [];
  let d = 0;
  for (let k = 0; k < SCRIPT.length; k++) {
    const line = SCRIPT[k];
    if (line.length === 4) {
      const [, verb, actor, label] = line;
      const world = actor === "world";
      out.push({ kind: "step", seq: world ? 0 : seqs[d], verb, actor, label });
    } else {
      const [channel, label, producer] = line;
      out.push({ seq: seqs[d++], channel, due: 1_800_000_025_000, label, producer });
    }
  }
  return out;
}

const orderOf = (events: SimEvent[]) => events.flatMap((e) => (e.kind === "step" ? [] : [e.channel]));

/** The replay lines, built by the sim's own replay.ts as report.ts and the api child build them. */
function replayOf(scenario: string, seed: number, order: string[], minimal: string[] | null, artifactDir: string): SimRunResponse["replay"] {
  const [trace, full, min = null] = replayCommands(scenario, seed, order, SIM_FIXTURE_LABELS[ROW_ID], minimal ?? undefined);
  return { trace, order: full, minimal: min, bisect: bisectCommand(artifactDir) };
}

/** Where the fixture's sim history lives, as `simHome()` would name it on a laptop. */
export const SIM_FIXTURE_HOME = "/Users/you/.local/share/codecast/sim";

export interface SimFixtureRunOpts {
  session: SimSession;
  run: SimRunRow;
  gitHead: string;
  /** A shrink has run: minimal.json and result.minimalOrder are present. */
  shrunk?: boolean;
  /** A shrink is running now: minimal.json.tmp's progress. */
  shrinking?: SimShrinkProgress | null;
}

export function simFixtureRun({ session, run, gitHead, shrunk = false, shrinking = null }: SimFixtureRunOpts): SimRunResponse {
  const events = eventsOf();
  const order = orderOf(events);
  const minimal: SimMinimal | null = shrunk ? { order: KEPT.map((i) => order[i]), removed: order.map((_, i) => i).filter((i) => !KEPT.includes(i)), attempts: 61, ms: 48_000, oneMinimal: true } : null;
  const replay = replayOf(run.scenario, run.seed, order, minimal?.order ?? null, `${SIM_FIXTURE_HOME}/sessions/${session.id}/${run.dir ?? `${run.scenario}-${run.mode}-${run.seed}`}`);
  const result: SimFailureResult = {
    scenario: run.scenario,
    mode: run.mode,
    seed: run.seed,
    gitHead,
    dirty: session.dirty,
    startedAt: session.startedAt,
    realMs: run.ms,
    step: "settle #2",
    delivery: order.length,
    invariant: INVARIANT,
    message: "laptop-follower still lists ada/s in its team slot after the removal",
    window: { name: LF, principal: "ada", scope: "team:acme" },
    row: {
      table: "sessions",
      id: ROW_ID,
      label: SIM_FIXTURE_LABELS[ROW_ID],
      diff: [
        { field: "team_id", server: "null", replica: '"acme"' },
        { field: "workspace", server: '"user:ada"', replica: '"team:acme"' },
        { field: "member_ids", server: '["bo"]', replica: '["ada","bo"]' },
      ],
    },
    order: formatOrder(order),
    labels: SIM_FIXTURE_LABELS,
    t0: 1_800_000_025_000,
    replay: [replay.trace, replay.order, ...(replay.minimal ? [replay.minimal] : [])],
    text: `sim failure: ${run.scenario} [${run.mode} seed ${run.seed}] at step "settle #2", after ${order.length} deliveries`,
    ...(minimal ? { minimalOrder: formatOrder(minimal.order) } : {}),
  };
  const world: SimWorld = {
    scenario: run.scenario,
    mode: run.mode,
    seed: run.seed,
    labels: SIM_FIXTURE_LABELS,
    devices: [
      { name: "laptop", windows: [{ name: LH, role: "host", closed: false }, { name: LF, role: "follower", closed: false }] },
      { name: "phone", windows: [{ name: PH, role: "host", closed: true }] },
    ],
  };
  return {
    session,
    run: { ...run, deliveries: order.length },
    result,
    events,
    world,
    final: {
      deliveries: order.length,
      writesSpent: 14,
      producers: { [`${LH} inbox`]: 2, [`${LH} team`]: 3, [`${LH} replicate`]: 4, "laptop daemon": 2, "sched agentTasks:generateDisplaySummary": 1 },
      calls: [
        { seq: 3, name: "teams:removeMember", kind: "mutation", ok: true },
        { seq: 9, name: "messages:send", kind: "mutation", ok: true },
        { seq: 14, name: "dispatch:dispatch", kind: "mutation", ok: false, error: "Forbidden: ada is not a member of acme" },
      ],
      actors: [{ actor: LH, verb: "send", ok: true }, { actor: "bo.admin", verb: "remove", ok: true }, { actor: PH, verb: "close", ok: false, error: "window already closing" }],
      windowErrors: { [LF]: ["applySlice: stale team slot for acme (cursor 41, head 44)"] },
    },
    minimal,
    shrinking,
    invariant: { ...INVARIANT, keys: ["sessions", "teamInboxIds"] },
    replay,
  };
}
