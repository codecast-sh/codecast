import { afterEach, expect, test } from "bun:test";
import { useInboxStore, classifySession, sessionStructuralSig } from "../inboxStore";
import { fleetBucket, hibernationCandidate, hibernationResultCounts } from "../../lib/hibernation";
import { sessionCommandOutcome } from "@codecast/shared/contracts";

const owner = {};
afterEach(() => { useInboxStore.getState()._clearDispatch(owner); });

test("request writes optimistic command state, never a false parked status; skip reconciles", async () => {
  const id = 'e2testconv000000000000000000000000';
  useInboxStore.setState({ sessionCommands: {}, sessions: { [id]: { _id: id, agent_status: 'idle', is_idle: true, message_count: 4 } }, pending: {} } as any);
  let finish!: () => void;
  const barrier = new Promise<void>(r => { finish = r; });
  useInboxStore.getState()._setDispatch(async () => { await barrier; return { command_id: 'command' }; }, { owner });
  const queued = useInboxStore.getState().hibernateSession('request', id, 'session', 'device');
  expect(sessionCommandOutcome(useInboxStore.getState().sessionCommands.request).message).toBe('parking requested');
  expect(useInboxStore.getState().sessions[id].agent_status).toBe('idle');
  finish(); await queued;
  useInboxStore.getState().syncTable('sessionCommands', [{ _id: 'request', conversation_id: id, executed_at: 100, result: 'skipped_attached', error: 'not parked: attached' }]);
  expect(sessionCommandOutcome(useInboxStore.getState().sessionCommands.request).state).toBe('skipped');
  expect(useInboxStore.getState().sessions[id].agent_status).toBe('idle');
  expect(hibernationResultCounts(Object.values(useInboxStore.getState().sessionCommands))).toEqual({ pending: 0, succeeded: 0, skipped: 1, failed: 0 });
});

test("store classifier and signatures reflect parking and wake while ignoring heartbeat churn", () => {
  const base: any = { _id: 'a', agent_status: 'dormant', is_idle: true, message_count: 5, updated_at: 100 };
  const parked = { ...base, agent_status: 'hibernated', hibernated_at: 100 };
  expect(classifySession(parked).rest).toBe('dormant');
  expect(classifySession({ ...parked, session_error: 'Wake failed' }).rest).toBe('needs_input');
  expect(sessionStructuralSig(parked)).not.toBe(sessionStructuralSig(base));
  expect(sessionStructuralSig({ ...parked, last_heartbeat: 999 })).toBe(sessionStructuralSig(parked));
  expect(classifySession({ ...parked, agent_status: 'working' }).idle).toBe(false);
});

test("fleet filter and candidate selection exclude active stale stamp, foreign, pending and unavailable ownership", () => {
  const row = { _id: 'a', user_id: 'me', session_id: 'a', conversation_id: 'conv', owner_device_id: 'dev', agent_status: 'idle', awake_idle_ms: 3 * 3600_000, last_heartbeat: 100 };
  expect(hibernationCandidate(row, 'me', 101)).toBe(true);
  for (const patch of [{ user_id: 'other' }, { owner_device_id: undefined }, { has_pending: true }, { awaiting_input: true }, { agent_status: 'working' }, { is_killed: true }]) expect(hibernationCandidate({ ...row, ...patch }, 'me', 101)).toBe(false);
  expect(fleetBucket({ ...row, agent_status: 'hibernated' }, 30 * 86400_000)).toBe('hibernated');
  expect(fleetBucket({ ...row, agent_status: 'working', hibernated_at: 10, awake_idle_ms: 0 }, 101)).toBe('active');
});
