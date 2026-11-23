import { describe, expect, test } from "bun:test";
import { HOSTED_AGENT_TYPE } from "./assistant";
import { DORMANT_CLAIM_TTL_MS } from "./agentStatus";
import {
  classifyWorkState,
  computeBucketStale,
  deriveLiveAt,
  inboxEpoch,
  type WorkingSetRow,
} from "./inboxProjection";
import { PARKED_WAKE_TTL_MS, placeProjectableRow, rowLiveDeadlines, rowPinPredatesTurn, rowWakeInputs } from "./inboxPlacement";

// The park facts a server-seen wake (parked_wake_kind) and a pin's freshness
// (rowPinPredatesTurn) add to placeProjectableRow. The rest of the park facts
// are in inboxProjection.test.ts.

const EPOCH = inboxEpoch(1_800_000_000_000);
const HOUR = 60 * 60 * 1000;

function row(id: string, overrides: Record<string, any> = {}): WorkingSetRow & Record<string, any> {
  return {
    _id: id,
    status: "active",
    updated_at: EPOCH - 2 * HOUR,
    message_count: 4,
    title: `Session ${id}`,
    ...overrides,
  };
}

describe("placeProjectableRow — server-seen wakes and pin freshness", () => {
  // A park the server can see (parked_wake_kind) is a verified wake: a live
  // workflow run the session spawned ("run", jx7eqd1) or an open blocker on
  // the task it holds ("blocker", jx7cn1s). Each keeps the daemon's dormant
  // past the claim window; when it dies the claim is judged again.
  test("a server-seen run or blocker keeps a dormant claim parked past the claim window", () => {
    const parked = (kind: string | null) => {
      const facts = row("p", {
        agent_status: "dormant", agent_status_updated_at: EPOCH - 3 * HOUR, updated_at: EPOCH - 3 * HOUR,
        last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000, message_count: 30, parked_wake_kind: kind,
      });
      return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, EPOCH) }, false, EPOCH).bucket;
    };
    expect(parked("run")).toBe("dormant");
    expect(parked("blocker")).toBe("dormant");
    expect(parked("none")).toBe("needs_input");
    expect(parked(null)).toBe("needs_input");
  });

  // The stamp can go stale (a run whose runner died stays "running", a PR
  // webhook never arrives), so it vouches only for PARKED_WAKE_TTL_MS of quiet.
  test("a wait stamp stops vouching after PARKED_WAKE_TTL_MS of quiet; a task blocker never does", () => {
    const quiet = (quietFor: number, extra: Record<string, any> = {}) =>
      row("p", { is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, parked_wake_kind: "wait", ...extra });
    expect(PARKED_WAKE_TTL_MS).toBe(72 * HOUR);
    expect(placeProjectableRow(quiet(71 * HOUR), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(quiet(73 * HOUR), false, EPOCH).bucket).toBe("needs_input");
    // A daemon-less pin carried only by the stamp expires with it.
    const pin = { agent_status: null, status: "completed", thread_state_status: "dormant" };
    expect(placeProjectableRow(quiet(71 * HOUR, pin), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(quiet(73 * HOUR, pin), false, EPOCH).bucket).toBe("needs_input");
    // jx7cn1s, quiet 4 days with its blocker task still open: the task graph
    // is recomputed on every write, so that stamp is exact and stays.
    expect(placeProjectableRow(quiet(96 * HOUR, { ...pin, parked_wake_kind: "blocker" }), false, EPOCH).bucket).toBe("dormant");
    // An armed trigger keeps its own rule: no TTL.
    expect(placeProjectableRow(quiet(73 * HOUR, { armed_trigger_kind: "standing" }), false, EPOCH).bucket).toBe("dormant");
  });

  test("the stamp's expiry is a shared deadline: the time flip lands on needs_input at updated_at + PARKED_WAKE_TTL_MS", () => {
    const placedAt = EPOCH - 70 * HOUR;
    const r = row("p", { is_idle: true, agent_status: "dormant", updated_at: placedAt, parked_wake_kind: "wait" });
    expect(rowLiveDeadlines(r as any)).toContain(placedAt + PARKED_WAKE_TTL_MS);
    const placeAt = (t: number) => placeProjectableRow(r, false, t);
    const stale = computeBucketStale({ deadlines: rowLiveDeadlines(r as any), placeAt, current: "dormant" }, EPOCH);
    expect(stale).toEqual({ bucket_stale_at: placedAt + PARKED_WAKE_TTL_MS, stale_bucket: "needs_input" });
  });

  // jx729tp: a lead with a standing trigger into it answered a person, then
  // pinned dormant. Its managed session is gone, so the only declaration left
  // is the pin, and the person spoke last, so the trigger is no structural
  // park. The armed trigger still wakes it, so the pin stands.
  test("a daemon-less pinned dormant parks while a verified wake stands", () => {
    const lead = (extra: Record<string, any> = {}) => {
      const facts = row("lead", {
        status: "completed", agent_status: null, updated_at: EPOCH - 5 * HOUR, message_count: 120,
        armed_trigger_kind: "standing", last_turn_origin: "person",
        last_message_preview: "yes, start a fix session", thread_state_status: "dormant", ...extra,
      });
      return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, EPOCH) }, false, EPOCH).bucket;
    };
    expect(lead()).toBe("dormant");
    expect(lead({ updated_at: EPOCH - 100 * HOUR })).toBe("dormant");
    expect(lead({ armed_trigger_kind: "none" })).toBe("needs_input");
    // A declared block beats every park.
    expect(lead({ thread_state_status: "blocked" })).toBe("needs_input");
    // No pin: the structural park keeps the last-turn rule, and a person spoke last.
    expect(lead({ thread_state_status: null })).not.toBe("dormant");
    // Any verified wake carries the pin; a bare pin with no daemon has no one to wake it.
    // A run executes on the spawner's machine: with no daemon, nothing resumes it.
    expect(lead({ armed_trigger_kind: "none", parked_wake_kind: "run" })).toBe("needs_input");
    expect(lead({ armed_trigger_kind: "none", parked_wake_kind: "blocker" })).toBe("dormant");
    expect(lead({ armed_trigger_kind: "none", parked_wake_kind: "none" })).toBe("needs_input");
    // A hard block still wins over the pinned park.
    expect(lead({ pending_api_error: true })).toBe("needs_input");
  });

  // A pin written before the latest turn (a session message, a trigger
  // inject, a wait's wake) is not the agent's word on that turn, which may
  // have ended asking. Without a daemon status (hibernated, a boundary, an
  // aged-out managed row) nothing else carries a verdict, so the stale pin
  // must not park the row.
  test("a daemon-less pinned dormant older than the latest turn parks nothing", () => {
    const stale = {
      updated_at: EPOCH - 3 * HOUR, message_count: 40, is_idle: true, last_turn_origin: "machine", last_turn_allows_park: false,
      thread_state_status: "dormant", thread_state_at: EPOCH - 5 * HOUR, last_turn_at: EPOCH - 4 * HOUR,
    };
    const place = (extra: Record<string, any>) => placeProjectableRow(row("s", { ...stale, ...extra }), false, EPOCH).bucket;
    expect(place({ agent_status: "hibernated", parked_wake_kind: "blocker" })).toBe("needs_input");
    expect(place({ agent_status: "idle", agent_status_boundary: true, armed_trigger_kind: "standing" })).toBe("needs_input");
    expect(place({ agent_status: null, parked_wake_kind: "run" })).toBe("needs_input");
    // A pin written after the turn opened, or a row with no turn stamp (it
    // predates the field, as jx729tp's does), still parks.
    expect(place({ agent_status: null, parked_wake_kind: "blocker", thread_state_at: EPOCH - 4 * HOUR })).toBe("dormant");
    expect(place({ agent_status: null, parked_wake_kind: "blocker", last_turn_at: null })).toBe("dormant");
    expect(place({ agent_status: "hibernated", parked_wake_kind: "blocker", last_turn_at: undefined })).toBe("dormant");
  });

  test("a daemon-less pinned done older than the latest turn is not done", () => {
    const pin = (extra: Record<string, any>) => placeProjectableRow(row("d", {
      updated_at: EPOCH - 3 * HOUR, message_count: 40, is_idle: true, agent_status: null, last_turn_origin: "machine",
      thread_state_status: "done", thread_state_at: EPOCH - 5 * HOUR, ...extra,
    }), false, EPOCH).bucket;
    expect(pin({ last_turn_at: EPOCH - 4 * HOUR })).toBe("needs_input");
    expect(pin({ last_turn_at: EPOCH - 6 * HOUR })).toBe("done");
    expect(pin({})).toBe("done");
  });

  // rowArmedHomes never parks a hosted conversation on its routine, so its
  // trigger is no verified wake either: a pin there has no one to deliver it.
  test("a hosted conversation's armed trigger is no verified wake", () => {
    const pin = (agent_type: string) =>
      placeProjectableRow(row("h", {
        agent_status: null, status: "completed", is_idle: true, updated_at: EPOCH - 5 * HOUR, message_count: 10, agent_type,
        armed_trigger_kind: "standing", thread_state_status: "dormant",
      }), false, EPOCH).bucket;
    expect(pin(HOSTED_AGENT_TYPE)).toBe("needs_input");
    expect(pin("claude_code")).toBe("dormant");
  });

  // A process that exits while pinned dormant on a server-seen park files the
  // same way as when its managed row later ages out: dormant.
  test("a dead process pinned dormant on a live park files dormant, the same as an aged-out row", () => {
    const parked = (extra: Record<string, any>) =>
      placeProjectableRow(row("x", {
        updated_at: EPOCH - 3 * HOUR, message_count: 30, is_idle: true, thread_state_status: "dormant", parked_wake_kind: "blocker", ...extra,
      }), false, EPOCH).bucket;
    expect(parked({ agent_status: "stopped" })).toBe("dormant");
    expect(parked({ agent_status: null })).toBe("dormant");
    // Past a wait's TTL, a stale pin, queued work, unresponsive, or a declared block: a human must look.
    expect(parked({ agent_status: "stopped", parked_wake_kind: "wait", updated_at: EPOCH - 73 * HOUR })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", thread_state_at: EPOCH - 5 * HOUR, last_turn_at: EPOCH - 4 * HOUR })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", has_pending_messages: true })).not.toBe("dormant");
    expect(parked({ agent_status: "stopped", is_unresponsive: true })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", thread_state_status: "blocked" })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", parked_wake_kind: "none" })).toBe("needs_input");
    // A run needs its spawner's machine: it counts only while that daemon's heartbeat lives.
    expect(parked({ agent_status: "stopped", parked_wake_kind: "run" })).toBe("needs_input");
    expect(parked({ agent_status: null, parked_wake_kind: "run" })).toBe("needs_input");
    expect(parked({ agent_status: "dormant", parked_wake_kind: "run", last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000 })).toBe("dormant");
  });

  // One rule for a run on every path: it counts only while the row's daemon
  // heartbeat lives. The daemon hibernates a dormant session after its idle
  // window; its heartbeat still beats, and so does the run.
  // A hung runner with a live pid is never resumed, and one that keeps dying
  // runs out of resumes: a run stamp also lives only PARKED_WAKE_TTL_MS.
  test("a run stamp stops vouching after PARKED_WAKE_TTL_MS of quiet, heartbeat or not", () => {
    const run = (quietFor: number) =>
      placeProjectableRow(row("r", {
        is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, message_count: 30, parked_wake_kind: "run",
        last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000,
      }), false, EPOCH).bucket;
    expect(run(PARKED_WAKE_TTL_MS - HOUR)).toBe("dormant");
    expect(run(PARKED_WAKE_TTL_MS)).toBe("needs_input");
  });

  test("a run stamp counts while the daemon's heartbeat lives, whatever the status", () => {
    const run = (extra: Record<string, any>) =>
      placeProjectableRow(row("r", {
        is_idle: true, updated_at: EPOCH - 5 * HOUR, message_count: 30, thread_state_status: "dormant",
        thread_state_at: EPOCH - 5 * HOUR, last_turn_at: EPOCH - 5 * HOUR - 60_000, parked_wake_kind: "run", ...extra,
      }), false, EPOCH).bucket;
    const alive = { last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000 };
    expect(run({ agent_status: "hibernated", ...alive })).toBe("dormant");
    expect(run({ agent_status: "dormant", ...alive })).toBe("dormant");
    // Heartbeat dead: a settled idle under a fresh dormant pin is no park on a run.
    expect(run({ agent_status: "idle", last_heartbeat: EPOCH - 5 * HOUR })).toBe("needs_input");
    expect(run({ agent_status: "hibernated", last_heartbeat: EPOCH - 5 * HOUR })).toBe("needs_input");
  });

  // A row with no last_turn_at (no turn since the stamp existed) falls back
  // to last_user_message_at with a minute of slack: a pre-deploy pin a later
  // turn never answered must not hide an asking session once a stamp lands.
  test("a legacy pin older than the newest user message by more than a minute parks nothing", () => {
    const legacy = (agent_status: string | null, kind: string) =>
      placeProjectableRow(row("l", {
        status: "active", message_count: 40, is_idle: true, updated_at: EPOCH - 20 * HOUR, agent_status, parked_wake_kind: kind,
        thread_state_status: "dormant", thread_state_at: EPOCH - 30 * HOUR, last_turn_origin: "machine", last_user_message_at: EPOCH - 20 * HOUR,
      }), false, EPOCH).bucket;
    for (const st of ["hibernated", "stopped", null]) for (const k of ["blocker", "wait"]) expect([st, k, legacy(st, k)]).toEqual([st, k, "needs_input"]);
    // jx729tp on prod: its pin's own `cast state` tool result lands 140ms
    // after the pin, and its standing trigger still parks it.
    const pinnedAt = EPOCH - 5 * HOUR;
    expect(placeProjectableRow(row("lead", {
      status: "completed", agent_status: null, is_idle: true, updated_at: pinnedAt + 140, message_count: 120,
      armed_trigger_kind: "standing", last_turn_origin: "person", last_turn_allows_park: false,
      thread_state_status: "dormant", thread_state_at: pinnedAt, last_user_message_at: pinnedAt + 140,
    }), false, EPOCH).bucket).toBe("dormant");
  });

  // jx729tp's shape: a standing trigger into a lead that answered a person and
  // pinned dormant. A trigger resumes a stopped session, so the dead arm reads
  // the same wake set as the daemon-less arm: no status, hibernated and
  // stopped all file the same, and the row does not flip when its managed row
  // ages out.
  test("a pinned dormant on a standing trigger files the same with no status, hibernated or stopped", () => {
    const lead = (agent_status: string | null, extra: Record<string, any> = {}) =>
      placeProjectableRow(row("lead", {
        status: "completed", agent_status, is_idle: true, updated_at: EPOCH - 5 * HOUR, message_count: 120,
        armed_trigger_kind: "standing", last_turn_origin: "person", last_turn_allows_park: false,
        last_message_preview: "yes, start a fix session", thread_state_status: "dormant", ...extra,
      }), false, EPOCH).bucket;
    for (const status of [null, "hibernated", "stopped"]) expect([status, lead(status)]).toEqual([status, "dormant"]);
    for (const status of [null, "hibernated", "stopped"]) expect([status, lead(status, { armed_trigger_kind: "none" })]).toEqual([status, "needs_input"]);
  });

  // A done pin answered an earlier turn when a later one opened since: a
  // process stopping after that unanswered turn is a death to read, not Done.
  test("a stopped process under a done pin older than the latest turn files needs_input", () => {
    const stopped = (extra: Record<string, any>) =>
      placeProjectableRow(row("e", {
        agent_status: "stopped", updated_at: EPOCH - HOUR, message_count: 30, is_idle: true,
        thread_state_status: "done", thread_state_at: EPOCH - 2 * HOUR, ...extra,
      }), false, EPOCH).bucket;
    expect(stopped({ last_turn_at: EPOCH - 3 * HOUR })).toBe("done");
    expect(stopped({ last_turn_at: EPOCH - HOUR })).toBe("needs_input");
  });

  // The daemon can overwrite a declared dormant or done with `working` when
  // it misreads a pane as busy, and the server decays a quiet `working` to
  // `idle` (jx76sve5q5m9 pinned done, then filed Needs You). A pin written in
  // or after the latest turn speaks over a settled idle, as if the daemon had
  // carried it.
  test("a fresh pin carries the verdict over a working the trust rule decayed to idle", () => {
    const settled = (extra: Record<string, any>) =>
      placeProjectableRow(row("i", {
        agent_status: "idle", raw_agent_status: "working", is_idle: true, updated_at: EPOCH - 3 * HOUR, message_count: 30,
        thread_state_at: EPOCH - 3 * HOUR, last_turn_at: EPOCH - 3 * HOUR - 60_000, ...extra,
      }), false, EPOCH).bucket;
    expect(settled({ thread_state_status: "done" })).toBe("done");
    expect(settled({ thread_state_status: "dormant", parked_wake_kind: "blocker" })).toBe("dormant");
    // A pin carried this way is still a dormant claim: with no wake it expires.
    expect(settled({ thread_state_status: "dormant" })).toBe("needs_input");
    expect(settled({ thread_state_status: "dormant", updated_at: EPOCH - HOUR, thread_state_at: EPOCH - HOUR, last_turn_at: EPOCH - HOUR })).toBe("dormant");
    // A pin older than the latest turn, or a row with no turn stamp: the settle's own verdict.
    expect(settled({ thread_state_status: "done", last_turn_at: EPOCH - 2 * HOUR })).toBe("needs_input");
    expect(settled({ thread_state_status: "done", last_turn_at: null })).toBe("needs_input");
    // A declared block still wins.
    expect(settled({ thread_state_status: "blocked" })).toBe("needs_input");
    // An idle the daemon reported itself always wins: it judges turns from the
    // transcript on its own clock, where the server can miss one (a session
    // move notice, a mid-turn auto-compaction).
    expect(settled({ raw_agent_status: "idle", thread_state_status: "done" })).toBe("needs_input");
    expect(settled({ raw_agent_status: "idle", thread_state_status: "dormant", parked_wake_kind: "blocker" })).toBe("needs_input");
  });

  // The round-5 probe: a session moved machines, the move notice opened a
  // turn the server did not count, the agent ended asking, and the daemon
  // reported idle. The old dormant pin must not speak over that idle.
  test("a daemon-reported idle after a move notice files needs_input under an older pin", () => {
    const wi = rowWakeInputs(
      { parked_wake_kind: "blocker", updated_at: EPOCH, last_turn_at: EPOCH - 600_000, thread_state_at: EPOCH - 300_000, thread_state_status: "dormant", agent_type: "claude_code", last_heartbeat: EPOCH } as any,
      { trusted: "idle", raw: "idle" },
      EPOCH + 3 * HOUR,
    );
    expect(classifyWorkState({ agentStatus: "idle", isIdle: true, awaitingInput: false, hasPending: false, isUnresponsive: false, messageCount: 10, declaredStatus: "dormant", ...wi })).toBe("needs_input");
  });

  // The turn's time is the machine's clock and the pin's the server's.
  // Strict, as the daemon compares: a turn seconds after the pin is one the
  // pin never answered (a `cast send` 3s after a done pin, a person's "yes"
  // 8s after a dormant pin).
  test("any turn after the pin predates it; a turn at or before it does not", () => {
    expect(rowPinPredatesTurn({ thread_state_at: EPOCH, last_turn_at: EPOCH })).toBe(false);
    expect(rowPinPredatesTurn({ thread_state_at: EPOCH, last_turn_at: EPOCH + 1 })).toBe(true);
    expect(rowPinPredatesTurn({ thread_state_at: EPOCH, last_turn_at: null })).toBe(false);
    const settled = (extra: Record<string, any>) =>
      placeProjectableRow(row("p", {
        agent_status: "idle", is_idle: true, updated_at: EPOCH - 30_000, message_count: 20, last_heartbeat: EPOCH - 1_000,
        thread_state_at: EPOCH - 60_000, ...extra,
      }), false, EPOCH).bucket;
    expect(settled({ thread_state_status: "done", last_turn_at: EPOCH - 57_000, last_turn_origin: "machine" })).toBe("needs_input");
    expect(settled({ thread_state_status: "dormant", last_turn_at: EPOCH - 52_000, last_turn_origin: "person" })).toBe("needs_input");
    expect(settled({ thread_state_status: "dormant", parked_wake_kind: "blocker", last_turn_at: EPOCH - 52_000, last_turn_origin: "person" })).toBe("needs_input");
  });

  test("a bare dormant claim still expires after DORMANT_CLAIM_TTL_MS", () => {
    const claim = (quietFor: number) =>
      row("d", { is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, parked_wake_kind: "none" });
    expect(placeProjectableRow(claim(DORMANT_CLAIM_TTL_MS - 60_000), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(DORMANT_CLAIM_TTL_MS), false, EPOCH).bucket).toBe("needs_input");
  });
});
