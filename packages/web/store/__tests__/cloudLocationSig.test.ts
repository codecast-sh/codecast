import { expect, test } from "bun:test";
import { sessionStructuralSig, sessionsWakeSig, type InboxSession } from "../inboxStore";

const base: InboxSession = { _id: "cloud-row", session_id: "native-session", updated_at: 1000, agent_type: "codex", message_count: 1, is_idle: true, has_pending: false, owner_device_id: "cloud-a", worktree_name: "work-a", worktree_branch: "codecast/work-a", cloud_placement: "pending" };
for (const change of [{owner_device_id: "cloud-b"}, {worktree_name: "work-b"}, {worktree_branch: "codecast/work-b"}, {cloud_placement: null}]) {
  test(`cloud location change wakes the memoized card: ${Object.keys(change)[0]}`, () => {
    const next = {...base,...change};
    expect(sessionStructuralSig(next)).not.toBe(sessionStructuralSig(base));
    expect(sessionsWakeSig({[base._id]:next})).not.toBe(sessionsWakeSig({[base._id]:base}));
  });
}
test("heartbeat-only changes do not wake the card", () => {
  expect(sessionStructuralSig({...base,last_heartbeat:9000})).toBe(sessionStructuralSig(base));
});
