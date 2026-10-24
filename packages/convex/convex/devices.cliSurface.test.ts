import { describe, expect, test } from "bun:test";
import { hashToken } from "./apiTokens";
import { enqueueAgentToolSetupCommand, listAgentBoxes, setDeviceShares, watchedCommandOutcome } from "./devices";
import { setCloudAutoscale } from "./cloud";
import { makeFakeDb } from "./testDb";

// `cast devices` and `cast hosts autoscale` reach these with the CLI's
// api_token, where the web reaches the same writes through dispatch. Each test
// runs the real handler with no web session, so only the token can authorize it.
const OWNER = "u".repeat(31) + "o";
const MATE = "u".repeat(31) + "m";
const STRANGER = "u".repeat(31) + "s";
const TEAM = "t".repeat(31) + "a";
const ELSEWHERE = "t".repeat(31) + "b";
const OWNER_TOKEN = "owner-cli-token";
const MATE_TOKEN = "mate-cli-token";

async function fixtures() {
  const now = Date.now();
  return makeFakeDb({
    users: [{ _id: OWNER, name: "Jason" }, { _id: MATE, name: "Ashot" }, { _id: STRANGER, name: "Stranger" }],
    teams: [{ _id: TEAM, name: "Union" }, { _id: ELSEWHERE, name: "Other" }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "admin" },
      { _id: "m3", user_id: STRANGER, team_id: ELSEWHERE, role: "member" },
    ],
    devices: [
      { _id: "d1", user_id: OWNER, device_id: "boxdev", label: "Union AWS 128GB", platform: "linux", last_seen: now, cli_version: "1.1.178" },
      { _id: "d2", user_id: OWNER, device_id: "cloudhost", label: "Linux - ip-1", platform: "linux", is_remote: true, last_seen: now },
    ],
    device_shares: [],
    daemon_commands: [],
    api_tokens: [
      { _id: "tok1", user_id: OWNER, token_hash: await hashToken(OWNER_TOKEN) },
      { _id: "tok2", user_id: MATE, token_hash: await hashToken(MATE_TOKEN) },
    ],
  });
}

function ctxFor(db: any) {
  return { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => {} } };
}

const run = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

describe("cast devices share over an api token", () => {
  test("the owner opens a machine to a team; a teammate's CLI then lists it with its version", async () => {
    const ctx = ctxFor(await fixtures());
    expect(await run(listAgentBoxes, ctx, { api_token: MATE_TOKEN })).toEqual([]);
    await run(setDeviceShares, ctx, { api_token: OWNER_TOKEN, device_id: "boxdev", team_ids: [TEAM] });
    const boxes = await run(listAgentBoxes, ctx, { api_token: MATE_TOKEN });
    expect(boxes.map((b: any) => [b.device_id, b.runner_name, b.cli_version])).toEqual([["boxdev", "Jason", "1.1.178"]]);
    await run(setDeviceShares, ctx, { api_token: OWNER_TOKEN, device_id: "boxdev", team_ids: [] });
    expect(await run(listAgentBoxes, ctx, { api_token: MATE_TOKEN })).toEqual([]);
  });

  test("only the owner can share, and only with a team they are on", async () => {
    const ctx = ctxFor(await fixtures());
    await expect(run(setDeviceShares, ctx, { api_token: MATE_TOKEN, device_id: "boxdev", team_ids: [TEAM] })).rejects.toThrow("Unknown device");
    await expect(run(setDeviceShares, ctx, { api_token: OWNER_TOKEN, device_id: "boxdev", team_ids: [ELSEWHERE] })).rejects.toThrow("team you are on");
    await expect(run(setDeviceShares, ctx, { device_id: "boxdev", team_ids: [TEAM] })).rejects.toThrow("Authentication required");
  });
});

describe("agent tool setup and its answer over an api token", () => {
  test("queues the command on the owner's machine and reads the daemon's verdict", async () => {
    const db = await fixtures();
    const ctx = ctxFor(db);
    const { command_id } = await run(enqueueAgentToolSetupCommand, ctx, { api_token: OWNER_TOKEN, device_id: "boxdev", tool: "browser", op: "check" });
    const row = db._tables.daemon_commands.find((r: any) => r._id === command_id);
    expect([row.command, row.target_device_id, row.user_id]).toEqual(["agent_tool_setup", "boxdev", OWNER]);
    expect(await run(watchedCommandOutcome, ctx, { api_token: OWNER_TOKEN, command_id })).toEqual({ state: "pending" });
    row.executed_at = Date.now();
    row.result = JSON.stringify({ tool: "browser", ready: true, paired: true, connected: true, chrome_running: true });
    expect((await run(watchedCommandOutcome, ctx, { api_token: OWNER_TOKEN, command_id })).setup.ready).toBe(true);
    expect(await run(watchedCommandOutcome, ctx, { api_token: MATE_TOKEN, command_id })).toBeNull();
  });

  test("a teammate cannot queue setup on a machine that is not theirs", async () => {
    const ctx = ctxFor(await fixtures());
    await expect(run(enqueueAgentToolSetupCommand, ctx, { api_token: MATE_TOKEN, device_id: "boxdev", tool: "computer", op: "start" })).rejects.toThrow("Unknown device");
  });
});

describe("cast hosts autoscale over an api token", () => {
  test("sets the policy on the owner's cloud host and refuses a machine that is not one", async () => {
    const db = await fixtures();
    const ctx = ctxFor(db);
    await run(setCloudAutoscale, ctx, { api_token: OWNER_TOKEN, host_device_id: "cloudhost", enabled: true, max_extra: 2, size: "t3.xlarge" });
    expect(db._tables.devices.find((d: any) => d._id === "d2").cloud_autoscale).toMatchObject({ enabled: true, max_extra: 2, size: "t3.xlarge" });
    await expect(run(setCloudAutoscale, ctx, { api_token: OWNER_TOKEN, host_device_id: "boxdev", enabled: true, max_extra: 1, size: "t3.xlarge" })).rejects.toThrow("Not a cloud host");
    await expect(run(setCloudAutoscale, ctx, { api_token: MATE_TOKEN, host_device_id: "cloudhost", enabled: true, max_extra: 1, size: "t3.xlarge" })).rejects.toThrow("Not a cloud host");
  });
});
