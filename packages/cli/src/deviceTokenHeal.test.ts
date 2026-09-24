// A machine whose device id moved (Migration Assistant, a disk clone, a host
// on new hardware) still holds a token bound to the old id. These run the real
// reader in real child processes against a scratch CODECAST_DIR and a fake
// Convex that binds tokens the way the server does, so the machine key
// rotation, the device id, the encryption and the lock are all the shipped
// code paths.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hardwareId } from "./machineKey.js";

const SRC = import.meta.dir;
const OLD = "bound_0ld0ld0ld0ld";
const PLAIN = "0123abcd0123abcd";

// The fake server: a token row per secret, bound to a device, and the mint.
const rows = new Map<string, string | undefined>();
let mints = 0;
let refuseAll = false;
let hang = false;
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as { path?: string; args?: any[] };
    seen.push(body.path ?? new URL(req.url).pathname);
    if (body.path !== "apiTokens:mintForDevice") return Response.json({ status: "error", errorMessage: `no ${body.path}` });
    const { api_token, device_id } = body.args![0];
    const [secret, device] = api_token.split(".");
    // A real round trip, so concurrent readers overlap it; or a server that never answers.
    // The hung wait ends when the client gives up, so the server can stop.
    await Promise.race([Bun.sleep(hang ? 60_000 : 250), new Promise((r) => req.signal.addEventListener("abort", r))]);
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (refuseAll || !rows.has(secret) || rows.get(secret) !== device) {
      return Response.json({ status: "error", errorMessage: "Unauthorized: invalid or expired token" });
    }
    const token = `bound_n3w${++mints}`;
    rows.set(token, device_id);
    return Response.json({ status: "success", value: { token } });
  },
});
afterAll(() => server.stop(true));

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-heal-"));
  rows.clear();
  mints = 0;
  refuseAll = false;
  hang = false;
  seen.length = 0;
});

const SCRIPT = `
import * as fs from "node:fs";
const { bearerFromStored, storedFromBearer, pendingDeviceTokenHeal } = await import(${JSON.stringify(`${SRC}/bearerToken.ts`)});
const { deviceId } = await import(${JSON.stringify(`${SRC}/remote/device.ts`)});
const { encryptToken } = await import(${JSON.stringify(`${SRC}/tokenEncryption.ts`)});
const file = process.env.CODECAST_DIR + "/config.json";
const [mode, arg] = process.argv.slice(2);
const out = { device: deviceId() };
try {
  if (mode === "login") {
    // What cast auth writes: the raw minted secret, through the one writer.
    fs.writeFileSync(file, JSON.stringify({ user_id: "u1", convex_url: process.env.FAKE_CONVEX, auth_token: storedFromBearer(arg) }));
  } else if (mode === "legacy") {
    // What 1.1.154 wrote for a bound token: the secret alone, encrypted.
    fs.writeFileSync(file, JSON.stringify({ user_id: "u1", convex_url: process.env.FAKE_CONVEX, auth_token: encryptToken(arg) }));
  } else if (mode === "write-back") {
    // A long lived process (the daemon) saving the token it read before a heal.
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
    cfg.auth_token = storedFromBearer(arg);
    fs.writeFileSync(file, JSON.stringify(cfg));
  } else {
    // The daemon's and an ordinary cast command's config load: the ones that heal.
    out.bearer = bearerFromStored(JSON.parse(fs.readFileSync(file, "utf-8")).auth_token, { heal: true });
    await pendingDeviceTokenHeal();
  }
} catch (err) {
  out.error = err.message;
}
console.log(JSON.stringify(out));
`;

async function cast(mode: string, arg = ""): Promise<{ device: string; bearer?: string; error?: string }> {
  const script = path.join(dir, "run.ts");
  if (!fs.existsSync(script)) fs.writeFileSync(script, SCRIPT);
  const proc = Bun.spawn(["bun", script, mode, arg], {
    env: { ...process.env, CODECAST_DIR: dir, FAKE_CONVEX: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = out.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`child failed: ${out}\n${err}`);
  return JSON.parse(line);
}

/** Make the scratch dir look like it was copied here from other hardware. */
function migrate(): void {
  fs.writeFileSync(path.join(dir, ".machine_key.hostid"), "0".repeat(64) + "\n");
  const binding = JSON.parse(fs.readFileSync(path.join(dir, ".device_binding.json"), "utf-8"));
  fs.writeFileSync(path.join(dir, ".device_binding.json"), JSON.stringify({ ...binding, hw: "OLD-HARDWARE" }));
}

const storedToken = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8")).auth_token as string;

// Rotation keys off the hardware id; a box without one never rotates.
const it = hardwareId() ? test : test.skip;

describe("a bound token on a machine whose device id moved", () => {
  it("heals exactly once and keeps working", async () => {
    const { device: oldDevice } = await cast("login", OLD);
    rows.set(OLD, oldDevice);
    migrate();

    const first = await cast("read");
    expect(first.device).not.toBe(oldDevice);
    // The read that finds the move still works: it presents the old device.
    expect(first.bearer).toBe(`${OLD}.${oldDevice}`);
    expect(mints).toBe(1);

    const second = await cast("read");
    expect(second.bearer).toBe(`bound_n3w1.${first.device}`);
    expect(rows.get("bound_n3w1")).toBe(first.device);
    const third = await cast("read");
    expect(third.bearer).toBe(second.bearer);
    expect(mints).toBe(1);
  }, 30_000);

  it("heals once when two processes find the move at the same time", async () => {
    const { device: oldDevice } = await cast("login", OLD);
    rows.set(OLD, oldDevice);
    migrate();

    const [a, b, c] = await Promise.all([cast("read"), cast("read"), cast("read")]);
    for (const r of [a, b, c]) expect(r.error).toBeUndefined();
    expect(mints).toBe(1);
    expect((await cast("read")).bearer).toBe(`bound_n3w1.${a.device}`);
    expect(mints).toBe(1);
  }, 30_000);

  it("recovers the minted device from .machine_key.prev for a token stored without one", async () => {
    const { device: oldDevice } = await cast("legacy", OLD);
    rows.set(OLD, oldDevice);
    migrate();

    await cast("read");
    const after = await cast("read");
    expect(after.bearer).toBe(`bound_n3w1.${after.device}`);
    expect(mints).toBe(1);
  }, 30_000);

  it("a process that saves the old token after the heal writes the healed one", async () => {
    const { device: oldDevice } = await cast("login", OLD);
    rows.set(OLD, oldDevice);
    migrate();
    await cast("read");

    await cast("write-back", `${OLD}.${oldDevice}`);
    const after = await cast("read");
    expect(after.bearer).toBe(`bound_n3w1.${after.device}`);
    expect(mints).toBe(1);
  }, 30_000);

  it("fails with a clear cast auth message when the server will not take the token, and never retries", async () => {
    await cast("legacy", OLD);
    refuseAll = true;
    migrate();

    await cast("read");
    const next = await cast("read");
    expect(next.error).toContain("cast auth");
    expect((await cast("read")).error).toContain("cast auth");
    expect(mints).toBe(0);
  }, 30_000);
});

describe("a heal never holds a process up", () => {
  it("the SessionStart hook on a moved machine neither mints nor stays alive", async () => {
    const { device: oldDevice } = await cast("login", OLD);
    rows.set(OLD, oldDevice);
    migrate();
    hang = true;

    const started = Date.now();
    const proc = Bun.spawn(["bun", `${SRC}/index.ts`, "stable-context"], {
      env: { ...process.env, CODECAST_DIR: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "hung")]);
    if (exit === "hung") proc.kill();
    expect(exit).not.toBe("hung");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(seen).not.toContain("apiTokens:mintForDevice");
  }, 30_000);

  it("a heal against a server that never answers gives up within the timeout and retries later", async () => {
    const { device: oldDevice } = await cast("login", OLD);
    rows.set(OLD, oldDevice);
    migrate();
    hang = true;

    const started = Date.now();
    const stuck = await cast("read");
    expect(stuck.bearer).toBe(`${OLD}.${oldDevice}`);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fs.existsSync(path.join(dir, ".device_token_heal.json"))).toBe(false);

    hang = false;
    await cast("read");
    expect((await cast("read")).bearer).toBe(`bound_n3w1.${stuck.device}`);
  }, 40_000);
});

describe("tokens the heal must not touch", () => {
  it("an unbound token is read as it is and never minted for, even after a move", async () => {
    await cast("login", PLAIN);
    const before = storedToken();
    migrate();
    const r = await cast("read");
    expect(r.bearer).toBe(PLAIN);
    expect(storedToken()).toBe(before);
    expect(mints).toBe(0);
  }, 30_000);

  it("a bound token on the machine it was minted for is presented with that machine", async () => {
    const { device } = await cast("login", OLD);
    rows.set(OLD, device);
    const r = await cast("read");
    expect(r.bearer).toBe(`${OLD}.${device}`);
    expect(mints).toBe(0);
  }, 30_000);
});
