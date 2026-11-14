import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { CAST_ENV_MAX_RUNNING, CAST_ENV_PATH, envMachineUserData, parseInstance, validPublicKey } from "./castCloudEnv";

setDefaultTimeout(60_000);

const KEY = "ssh-ed25519 " + "A".repeat(68) + " me@laptop";
const TOKEN = "cast-env-test-token";
const envKeys = ["CAST_MACHINES_USERS", "CAST_MACHINES_AWS_ACCESS_KEY_ID", "CAST_MACHINES_AWS_SECRET_ACCESS_KEY"];
let saved: Array<string | undefined>;
const realFetch = globalThis.fetch;
let ec2Calls: URLSearchParams[] = [];
let running = 0;

const describeXml = (id: string, state: string, ip?: string) =>
  `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>${id}</instanceId><instanceType>t3.large</instanceType><instanceState><code>16</code><name>${state}</name></instanceState>${ip ? `<ipAddress>${ip}</ipAddress>` : ""}</item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;

beforeEach(() => {
  saved = envKeys.map((k) => process.env[k]);
  process.env.CAST_MACHINES_AWS_ACCESS_KEY_ID = "AKIATEST";
  process.env.CAST_MACHINES_AWS_SECRET_ACCESS_KEY = "secret";
  ec2Calls = [];
  running = 0;
  // EC2 answers by Action; nothing leaves the process.
  globalThis.fetch = (async (url: string, init: any) => {
    if (!String(url).includes("ec2.")) return realFetch(url, init);
    const p = new URLSearchParams(String(init.body));
    ec2Calls.push(p);
    const action = p.get("Action");
    if (action === "DescribeInstances" && p.get("Filter.1.Name")) return new Response(Array.from({ length: running }, (_, i) => `<instanceId>i-0${i}</instanceId>`).join(""));
    if (action === "RunInstances") return new Response(`<RunInstancesResponse><instancesSet><item><instanceId>i-0abc</instanceId><instanceState><code>0</code><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`);
    if (action === "DescribeInstances") return new Response(describeXml(p.get("InstanceId.1")!, "running", "203.0.113.7"));
    return new Response("<ok/>");
  }) as any;
});
afterEach(() => {
  envKeys.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]);
  globalThis.fetch = realFetch;
});

async function setup() {
  const t = convexTest(schema, allModules);
  const user = await t.run(async (ctx) => {
    const u = await ctx.db.insert("users", { name: "me" } as any);
    await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    return u;
  });
  const call = async (body: object) => {
    const r = await t.fetch(CAST_ENV_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: TOKEN, ...body }) });
    return { status: r.status, body: await r.json() as any };
  };
  return { t, user, call };
}

describe("cast cloud machines", () => {
  test("only enabled people get one", async () => {
    const { call } = await setup();
    expect((await call({ op: "request", ssh_public_key: KEY })).status).toBe(403);
    expect(ec2Calls).toHaveLength(0);
  });

  test("a request launches one machine from the template with the laptop's key, and asking again returns it", async () => {
    const { t, user, call } = await setup();
    process.env.CAST_MACHINES_USERS = String(user);
    const first = await call({ op: "request", ssh_public_key: KEY });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ instance_id: "i-0abc", Reservations: [{ Instances: [{ InstanceId: "i-0abc" }] }] });
    const run = ec2Calls.find((p) => p.get("Action") === "RunInstances")!;
    expect(run.get("LaunchTemplate.LaunchTemplateName")).toBe("cast-cloud-env");
    expect(atob(run.get("UserData")!)).toContain(KEY);
    const rows = await t.run((ctx) => ctx.db.query("cast_env_machines").collect());
    expect(rows).toMatchObject([{ instance_id: "i-0abc", ssh_public_key: KEY }]);
    ec2Calls = [];
    const again = await call({ op: "request", ssh_public_key: KEY });
    expect(again.body).toMatchObject({ instance_id: "i-0abc", Reservations: [{ Instances: [{ State: { Name: "running" }, PublicIpAddress: "203.0.113.7" }] }] });
    expect(ec2Calls.some((p) => p.get("Action") === "RunInstances")).toBe(false);
  });

  test("the running cap refuses a launch and a start", async () => {
    const { user, call } = await setup();
    process.env.CAST_MACHINES_USERS = String(user);
    running = CAST_ENV_MAX_RUNNING;
    expect((await call({ op: "request", ssh_public_key: KEY })).status).toBe(503);
  });

  test("describe, start and stop act on the caller's own instance only", async () => {
    const { user, call } = await setup();
    process.env.CAST_MACHINES_USERS = String(user);
    expect((await call({ op: "describe" })).status).toBe(404);
    await call({ op: "request", ssh_public_key: KEY });
    ec2Calls = [];
    await call({ op: "stop" });
    expect(ec2Calls.map((p) => [p.get("Action"), p.get("InstanceId.1")])).toContainEqual(["StopInstances", "i-0abc"]);
    ec2Calls = [];
    await call({ op: "start" });
    expect(ec2Calls.map((p) => [p.get("Action"), p.get("InstanceId.1")])).toContainEqual(["StartInstances", "i-0abc"]);
  });

  test("a bad token or a key that is not a key is refused", async () => {
    const { user, call, t } = await setup();
    process.env.CAST_MACHINES_USERS = String(user);
    const r = await t.fetch(CAST_ENV_PATH, { method: "POST", body: JSON.stringify({ api_token: "nope", op: "describe" }) });
    expect(r.status).toBe(401);
    expect((await call({ op: "request", ssh_public_key: "ssh-ed25519 AAAA'; rm -rf / #" })).status).toBe(400);
  });
});

test("the boot script carries only a validated key", () => {
  expect(validPublicKey(KEY)).toBe(true);
  expect(validPublicKey("ssh-ed25519 AAAA$(reboot)")).toBe(false);
  expect(() => envMachineUserData("x' ; reboot")).toThrow();
  expect(envMachineUserData(KEY)).toContain("authorized_keys");
});

test("parseInstance reads state, address and type from EC2's XML", () => {
  expect(parseInstance(describeXml("i-01", "stopped"))).toEqual({ InstanceId: "i-01", State: { Name: "stopped" }, InstanceType: "t3.large" });
  expect(parseInstance("<x/>")).toBeNull();
});
