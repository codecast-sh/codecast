import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type DecisionStackItem } from "../inboxStore";

// The stack page's one write path (the-line.md L10): setStackPolicy paints
// the policy on the draft and rides the named dispatch side effect. The
// painted object must stringify like the server's echo (sorted keys, no
// undefined) or the field lock never retires; a delegate resolves server
// side, so that write must not lock the object at all.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const STACK = serverId("stack1");

// The server bumps updated_at with every policy write; an echo carries it.
const stackRow = (policy: DecisionStackItem["policy"], updated_at = 1): DecisionStackItem => ({
  _id: STACK, short_id: "ds-1", title: "Launch", owner_user_id: serverId("me"), policy,
  status: "open", decision_ids: [], total: 0, resolved: 0, pending: 0, created_at: 1, updated_at,
});

type Call = { action: string; args: any[] };

describe("setStackPolicy", () => {
  const owner = {};
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    useInboxStore.setState({ decisionStacks: { [STACK]: stackRow({ delegate_role_id: serverId("role1") }) }, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action, args) => { calls.push({ action, args }); return null; }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  const flush = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

  it("paints the due before any round trip and dispatches the mutation's own argument names", async () => {
    useInboxStore.getState().setStackPolicy(STACK, { due_at: 5_000 });
    const s = useInboxStore.getState();
    expect(s.decisionStacks[STACK].policy.due_at).toBe(5_000);
    // Sorted keys: the same text Convex returns for the stored object.
    expect(Object.keys(s.decisionStacks[STACK].policy)).toEqual(["delegate_role_id", "due_at"]);
    expect(s.pending[`decisionStacks:${STACK}:policy`]?.type).toBe("field");
    await flush();
    expect(calls).toEqual([{ action: "setStackPolicy", args: [STACK, { due_at: 5_000 }] }]);
  });

  it("the lock retires on the server's echo even when the echo's key order differs from the write order", async () => {
    useInboxStore.getState().setStackPolicy(STACK, { auto_default_after_ms: 3_600_000 });
    // Convex sorts keys: auto_default_after_ms lands before delegate_role_id.
    useInboxStore.getState().syncTable("decisionStacks", [stackRow({ auto_default_after_ms: 3_600_000, delegate_role_id: serverId("role1") }, 2)]);
    const s = useInboxStore.getState();
    expect(s.pending[`decisionStacks:${STACK}:policy`]).toBeUndefined();
    expect(s.decisionStacks[STACK].policy.auto_default_after_ms).toBe(3_600_000);
  });

  it("clearing the due drops the key so the echo without it matches", async () => {
    useInboxStore.setState({ decisionStacks: { [STACK]: stackRow({ due_at: 5_000 }) } } as any);
    useInboxStore.getState().setStackPolicy(STACK, { clear_due: true });
    expect("due_at" in useInboxStore.getState().decisionStacks[STACK].policy).toBe(false);
    useInboxStore.getState().syncTable("decisionStacks", [stackRow({}, 2)]);
    expect(useInboxStore.getState().pending[`decisionStacks:${STACK}:policy`]).toBeUndefined();
    await flush();
    expect(calls[0].args[1]).toEqual({ clear_due: true });
  });

  it("a delegate only write dispatches without locking the policy, so the resolved role paints from the echo", async () => {
    useInboxStore.setState({ decisionStacks: { [STACK]: stackRow({}) } } as any);
    useInboxStore.getState().setStackPolicy(STACK, { delegate: "lead" });
    expect(useInboxStore.getState().pending[`decisionStacks:${STACK}:policy`]).toBeUndefined();
    await flush();
    expect(calls).toEqual([{ action: "setStackPolicy", args: [STACK, { delegate: "lead" }] }]);
    useInboxStore.getState().syncTable("decisionStacks", [stackRow({ delegate_role_id: serverId("role2") }, 2)]);
    expect(useInboxStore.getState().decisionStacks[STACK].policy.delegate_role_id).toBe(serverId("role2"));
  });
});

describe("setStackPolicy result", () => {
  const owner = {};
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  it("resolves the server's { error } refusal to the caller, so the page can toast it instead of success", async () => {
    useInboxStore.setState({ decisionStacks: { [STACK]: stackRow({}) }, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async () => ({ error: "Role not found: nobody" }), { owner });
    const r = await useInboxStore.getState().setStackPolicy(STACK, { delegate: "nobody" });
    expect(r).toEqual({ error: "Role not found: nobody" });
    expect(useInboxStore.getState().decisionStacks[STACK].policy.delegate_role_id).toBeUndefined();
  });
});
