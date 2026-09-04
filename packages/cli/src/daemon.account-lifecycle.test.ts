import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AccountLifecycleGate } from "./accountLifecycleGate.js";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion.js";
import { waitFor } from "./test-helpers/messagingHarness.js";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const resumeSource = functionBlock(source, "autoResumeSession").text;
const ownerSource = functionBlock(source, "resumeOwnerVerdict").text.replace("export ", "");
const switchSource = blockAt(source, source.indexOf('      case "switch_account": {')).text;
type Resume = (id: string, content: string, cache: object, cwd?: string, conversation?: string, agent?: string, opts?: object) => Promise<boolean>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const gate = new AccountLifecycleGate();
  const events: string[] = [];
  const state = { account: "old", forbidden: false, owner: "local", ownerReads: 0, resumeAcquires: 0, switchAcquires: 0 };
  const hooks = {
    launch: (async () => true) as Resume,
    swap: (_profile: string) => {},
    kill: async (_conversation: string, _session?: string) => {},
    enqueue: async (_conversation: string) => {},
  };
  const acquireResume = gate.acquireResume.bind(gate);
  gate.acquireResume = agent => { state.resumeAcquires++; return acquireResume(agent); };
  const acquireSwitch = gate.acquireSwitch.bind(gate);
  gate.acquireSwitch = () => { state.switchAcquires++; return acquireSwitch(); };
  const resumeInFlight = new Map<string, Promise<boolean>>();
  const resumeInFlightStarted = new Map<string, number>();
  const resumeSessionCache = new Map<string, string>();
  const hibernationInFlight = new Map<string, { cancel: () => void; done: Promise<void> }>();
  const expectedHibernationExits = new Map<string, unknown>();
  const sync = {
    getConversationOwnerInfo: async () => {
      state.ownerReads++;
      return { ownerDeviceId: state.owner, ownerOnline: true };
    },
    enqueueUserMessage: async (conversation: string) => {
      events.push(`enqueue:${conversation}`);
      await hooks.enqueue(conversation);
    },
  };
  const deps = {
    accountLifecycleGate: gate, resumeInFlight, resumeInFlightStarted, resumeSessionCache,
    hibernationInFlight, expectedHibernationExits, lastResumeAt: new Map<string, number>(),
    RESUME_IN_FLIGHT_TIMEOUT_MS: 60_000, SWITCH_CONTINUE_SPACING_MS: 1,
    conversationForbidsResurrection: async () => state.forbidden,
    syncServiceRef: sync, deviceId: () => "local", isRemoteDevice: () => false,
    log: () => {}, logDelivery: () => {},
    resumeInnerForTests: async (...args: Parameters<Resume>) => {
      events.push(`launch:${args[0]}:${state.account}`);
      return hooks.launch(...args);
    },
    autoResumeSessionInner: () => { throw new Error("unexpected real launch"); },
    clearHibernationPark: (id: string) => { events.push(`clear:${id}`); },
    injectViaTmux: async (_target: string, content: string) => { events.push(`inject:${content}`); },
    useProfile: (profile: string) => {
      hooks.swap(profile);
      state.account = profile;
      events.push(`swap:${profile}`);
      return { to: profile };
    },
    killConversationBackends: async (conv: string, session?: string) => {
      events.push(`kill:${conv}`);
      await hooks.kill(conv, session);
      return { result: "killed_tmux" };
    },
    saveProfile: (name: string) => ({ name }), deleteProfile: () => ({}),
    startMintFlow: async () => "minted", sendHeartbeat: async () => {},
    pushCredentialToRemoteHosts: async () => {}, maintainCcUsageSnapshots: async () => {},
    maintainCodexUsageSnapshot: async () => {},
  };
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    ${ownerSource}
    ${resumeSource}
    async function switchAccount(parsed) {
      const commandArgs = JSON.stringify(parsed), commandId = "test-command";
      let result, error;
      switch ("switch_account") { ${switchSource} }
      return { result, error };
    }
  `);
  const runtime = new Function(...Object.keys(deps), `${code}; return { resume: autoResumeSession, switchAccount };`)(...Object.values(deps)) as {
    resume: Resume;
    switchAccount: (args: Record<string, unknown>) => Promise<{ result?: string; error?: string }>;
  };
  return { ...runtime, gate, state, hooks, events, resumeInFlight, resumeInFlightStarted, resumeSessionCache, hibernationInFlight, expectedHibernationExits };
}

test("production switch waits for Claude readiness and cleanup; queued Claude waits for teardown, Codex bypasses", async () => {
  const h = harness(), boot = deferred(), teardown = deferred();
  h.hooks.launch = async id => { if (id === "first") await boot.promise; return true; };
  h.hooks.swap = () => { expect(h.resumeInFlight.has("first")).toBe(false); };
  h.hooks.kill = async () => { await teardown.promise; };
  const first = h.resume("first", "", {}, undefined, "first-conv", "claude");
  await waitFor(() => h.events.includes("launch:first:old"));
  const change = h.switchAccount({ profile: "new", conversation_ids: ["first-conv"] });
  await waitFor(() => h.state.switchAcquires === 1);
  const queued = h.resume("queued", "", {}, undefined, "queued-conv", "claude");
  try {
    expect(await h.resume("codex", "", {}, undefined, "codex-conv", "codex")).toBe(true);
    expect(h.state.account).toBe("old");
    boot.resolve();
    await first;
    await waitFor(() => h.events.includes("kill:first-conv"));
    expect(h.events).not.toContain("launch:queued:new");
  } finally { boot.resolve(); teardown.resolve(); }
  expect((await change).error).toBeUndefined();
  expect(await queued).toBe(true);
  expect(h.events.indexOf("clear:first")).toBeLessThan(h.events.indexOf("swap:new"));
  expect(h.events.indexOf("enqueue:first-conv")).toBeLessThan(h.events.indexOf("launch:queued:new"));
});

test("production resume retains one reservation across account wait and cancelled park, forwarding launch intent unchanged", async () => {
  const h = harness(), parked = deferred();
  let cancels = 0, launches = 0;
  const opts = { userInitiated: true, model: "saved-model", effort: "high" };
  h.hooks.launch = async (...args) => { launches++; expect(args[6]).toBe(opts); return true; };
  h.resumeSessionCache.set("same", "owned-pane");
  h.expectedHibernationExits.set("same", true);
  h.hibernationInFlight.set("same", { cancel: () => { cancels++; }, done: parked.promise });
  const release = await h.gate.acquireSwitch();
  const first = h.resume("same", "", {}, "/saved/cwd", "conv", "claude", opts);
  const second = h.resume("same", "second", {}, "/saved/cwd", "conv", "claude", opts);
  try {
    await waitFor(() => h.state.resumeAcquires === 1);
    expect(h.resumeInFlight.has("same")).toBe(true);
    expect(cancels).toBe(0);
    release();
    await waitFor(() => cancels === 1);
    expect(launches).toBe(0);
    parked.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(launches).toBe(1);
    expect(cancels).toBe(1);
    expect(h.expectedHibernationExits.has("same")).toBe(false);
    expect(h.resumeInFlight.has("same")).toBe(false);
    expect(h.events.filter(e => e === "clear:same")).toHaveLength(1);
    expect(h.events).toContain("inject:second");
  } finally { release(); parked.resolve(); }
});

test("reservation invalidated during account wait cannot cancel a park or launch and releases its hold", async () => {
  const h = harness(), release = await h.gate.acquireSwitch();
  const newer = Promise.resolve(true);
  let cancels = 0;
  h.hibernationInFlight.set("old", { cancel: () => { cancels++; }, done: Promise.resolve() });
  const resume = h.resume("old", "", {}, undefined, "conv", "claude");
  try {
    await waitFor(() => h.state.resumeAcquires === 1);
    h.resumeInFlight.set("old", newer);
    release();
    expect(await resume).toBe(false);
    expect(h.resumeInFlight.get("old")).toBe(newer);
    expect(cancels).toBe(0);
    expect(h.events).toEqual([]);
    (await h.gate.acquireSwitch())();
  } finally { release(); }
});

for (const refusal of ["lifecycle", "owner"] as const) {
  test(`production resume rechecks ${refusal} after account wait`, async () => {
    const h = harness(), release = await h.gate.acquireSwitch();
    const resume = h.resume("waiting", "", {}, undefined, "conv", "claude");
    try {
      await waitFor(() => h.state.resumeAcquires === 1);
      if (refusal === "lifecycle") h.state.forbidden = true;
      else h.state.owner = "other-live-device";
      release();
      expect(await resume).toBe(false);
      expect(h.events).toEqual([]);
      expect(h.resumeInFlight.has("waiting")).toBe(false);
      (await h.gate.acquireSwitch())();
    } finally { release(); }
  });
}

for (const refusal of ["lifecycle", "owner", "reservation"] as const) {
  test(`production resume rechecks ${refusal} after waiting for park cancellation`, async () => {
    const h = harness(), parked = deferred();
    let cancels = 0;
    const newer = Promise.resolve(true);
    h.hibernationInFlight.set("parked", { cancel: () => { cancels++; }, done: parked.promise });
    h.expectedHibernationExits.set("parked", true);
    const resume = h.resume("parked", "", {}, undefined, "conv", "claude");
    try {
      await waitFor(() => cancels === 1);
      if (refusal === "lifecycle") h.state.forbidden = true;
      else if (refusal === "owner") h.state.owner = "other-live-device";
      else h.resumeInFlight.set("parked", newer);
      parked.resolve();
      expect(await resume).toBe(false);
      expect(h.events).toEqual([]);
      expect(h.expectedHibernationExits.has("parked")).toBe(true);
      expect(h.resumeInFlight.get("parked")).toBe(refusal === "reservation" ? newer : undefined);
      (await h.gate.acquireSwitch())();
    } finally { parked.resolve(); }
  });
}

test("an initial refusal does not wait for credentials, while explicit user resume retains its bypass", async () => {
  const h = harness(), release = await h.gate.acquireSwitch();
  h.state.forbidden = true;
  try {
    expect(await h.resume("forbidden", "", {}, undefined, "conv", "claude")).toBe(false);
    expect(h.state.resumeAcquires).toBe(0);
    expect(await h.resume("explicit", "", {}, undefined, "conv", "codex", { userInitiated: true })).toBe(true);
    expect(h.state.ownerReads).toBe(2);
  } finally { release(); }
});

test("failed boot, failed swap and no-profile recovery all release the production gate", async () => {
  const h = harness();
  h.hooks.launch = async () => { throw new Error("boot failed"); };
  await expect(h.resume("bad", "", {}, undefined, "conv", "claude")).rejects.toThrow("boot failed");
  expect(h.resumeInFlight.has("bad")).toBe(false);
  h.hooks.swap = () => { throw new Error("swap failed"); };
  expect((await h.switchAccount({ profile: "bad", conversation_ids: ["conv"] })).error).toContain("swap failed");
  expect(h.events).not.toContain("kill:conv");
  const recovery = await h.switchAccount({ conversation_ids: ["conv"], continue_blocked: false });
  expect(JSON.parse(recovery.result!)).toEqual({ switched: null, killed: 1, continued: 0 });
  h.hooks.launch = async () => false;
  expect(await h.resume("failed", "", {}, undefined, "conv", "claude")).toBe(false);
  expect(h.events).not.toContain("clear:failed");
  (await h.gate.acquireSwitch())();
});

test("profile maintenance bypasses the switch hold and paced continues do not hold it for minutes", async () => {
  const h = harness(), release = await h.gate.acquireSwitch();
  try {
    for (const args of [{ save_as: "saved" }, { remove: "saved" }, { refresh_usage: true }, { mint: "account" }]) {
      expect((await h.switchAccount(args)).error).toBeUndefined();
    }
    expect(h.state.switchAcquires).toBe(1);
  } finally { release(); }
  const rest = deferred();
  h.hooks.enqueue = async conv => { if (conv === "rest") await rest.promise; };
  try {
    const result = await h.switchAccount({ profile: "new", conversation_ids: ["first", "rest"] });
    expect(JSON.parse(result.result!).continued).toBe(2);
    (await h.gate.acquireSwitch())();
    await waitFor(() => h.events.includes("enqueue:rest"));
  } finally { rest.resolve(); }
});

test("daemon wires one shared account gate without wrapping the Codex app-server", () => {
  expect(source.match(/const accountLifecycleGate = new AccountLifecycleGate\(\);/g)).toHaveLength(1);
  expect(switchSource).toContain("accountLifecycleGate.acquireSwitch()");
  expect(resumeSource).toContain("accountLifecycleGate.acquireResume(agentTypeHint)");
  expect(switchSource).not.toContain("markAppServerConversationResumable(");
  expect(resumeSource).not.toContain("markAppServerConversationResumable(");
  expect(resumeSource).not.toContain("new CodexAppServer(");
});
