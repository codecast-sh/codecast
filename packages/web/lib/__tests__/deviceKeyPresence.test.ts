// The in-app Touch ID / Face ID flow (lib/deviceKeyPresence): a key already
// set up signs the challenge with the action's words; the first credential
// sets up at once; with a passkey elsewhere, setting up spends one grant
// confirmed another way, or the person hands this one off; a cancel at any
// prompt sends nothing; no signer reads unavailable.
import { describe, expect, test } from "bun:test";
import { UNAVAILABLE, confirmWithDeviceKey, type DeviceKeyDeps } from "../deviceKeyPresence";

function harness(o: { keys?: { device_key?: string }[]; local?: string | null; available?: boolean; offer?: "setup" | "elsewhere" | "cancel"; signAnswer?: any; createAnswer?: any } = {}) {
  const calls: string[] = [];
  let local = o.local ?? null;
  const deps: DeviceKeyDeps = {
    appName: "Codecast app",
    signer: {
      status: async () => ({ available: o.available ?? true, credential_id: local, name: "MacBook-Pro-2" }),
      create: async (a) => (calls.push(`create:${a.reason}`), o.createAnswer ?? { public_key: "PUB", signature: "REGSIG", credential_id: "new-key" }),
      keep: async (id) => (calls.push(`keep:${id}`), (local = id)),
      sign: async (a) => (calls.push(`sign:${a.challenge}:${a.reason}`), o.signAnswer ?? { signature: "SIG", credential_id: local! }),
    },
    list: async () => (o.keys ?? []).map((k, i) => ({ _id: String(i), name: "k", created_at: 0, ...k })),
    begin: async (action, target, from) => (calls.push(`begin:${action}:${target}:${from}`), { challenge_id: "ch", options: { challenge: "CHAL" }, grant: "GRANT" as any, label: "stripe-live for jx7ana1" }),
    registrationBegin: async (grant, from) => (calls.push(`register-begin:${grant ?? "-"}:${from}`), { challenge_id: "reg", options: { challenge: "REGCHAL" } }),
    register: async (id, pub, sig, name) => (calls.push(`register:${id}:${pub}:${sig}:${name}`), { credential_id: "new-key" }),
    confirm: async (id, cred, sig) => (calls.push(`confirm:${id}:${cred}:${sig}`), { granted: true as const }),
    confirmElsewhere: async (action) => (calls.push(`elsewhere:${action}`), "ADD-GRANT" as any),
    offerSetUp: async () => (calls.push("offer"), o.offer ?? "setup"),
    fail: (m) => calls.push(`fail:${m}`),
  };
  return { deps, calls };
}

describe("confirmWithDeviceKey", () => {
  test("a key already set up here signs the challenge with the action's words and answers the grant", async () => {
    const { deps, calls } = harness({ keys: [{ device_key: "mine" }], local: "mine" });
    expect(await confirmWithDeviceKey("approve", "dec1", deps)).toBe("GRANT" as any);
    expect(calls).toEqual(["begin:approve:dec1:MacBook-Pro-2", "sign:CHAL:approve this decision: stripe-live for jx7ana1", "confirm:ch:mine:SIG"]);
  });

  test("with no credential at all, the key sets up at once, named for this machine, then confirms", async () => {
    const { deps, calls } = harness();
    expect(await confirmWithDeviceKey("reveal", "s1", deps)).toBe("GRANT" as any);
    expect(calls.slice(0, 4)).toEqual([
      "register-begin:-:MacBook-Pro-2",
      "create:set up Touch ID for Codecast",
      "register:reg:PUB:REGSIG:Codecast app on MacBook-Pro-2",
      "keep:new-key",
    ]);
    expect(calls).not.toContain("offer");
  });

  test("with a passkey elsewhere, setting up spends one add_passkey grant confirmed another way", async () => {
    const { deps, calls } = harness({ keys: [{}] });
    expect(await confirmWithDeviceKey("approve", "dec1", deps)).toBe("GRANT" as any);
    expect(calls.slice(0, 3)).toEqual(["offer", "elsewhere:add_passkey", "register-begin:ADD-GRANT:MacBook-Pro-2"]);
  });

  test("choosing the browser hands off; cancelling the offer, the setup or the prompt sends nothing", async () => {
    expect(await confirmWithDeviceKey("approve", "d", harness({ keys: [{}], offer: "elsewhere" }).deps)).toBe(UNAVAILABLE);
    expect(await confirmWithDeviceKey("approve", "d", harness({ keys: [{}], offer: "cancel" }).deps)).toBeNull();

    const setupCancelled = harness({ createAnswer: { cancelled: true } });
    expect(await confirmWithDeviceKey("approve", "d", setupCancelled.deps)).toBeNull();
    expect(setupCancelled.calls.some((c) => c.startsWith("register:") || c.startsWith("fail"))).toBe(false);

    const signCancelled = harness({ keys: [{ device_key: "mine" }], local: "mine", signAnswer: { cancelled: true } });
    expect(await confirmWithDeviceKey("approve", "d", signCancelled.deps)).toBeNull();
    expect(signCancelled.calls.some((c) => c.startsWith("confirm:") || c.startsWith("fail"))).toBe(false);
  });

  test("a key this app holds that the server no longer knows (removed in Settings) is set up again", async () => {
    const { deps, calls } = harness({ keys: [{ device_key: "other" }], local: "stale" });
    await confirmWithDeviceKey("approve", "d", deps);
    expect(calls[0]).toBe("offer");
  });

  test("no signer here reads unavailable", async () => {
    expect(await confirmWithDeviceKey("approve", "d", harness({ available: false }).deps)).toBe(UNAVAILABLE);
  });
});
