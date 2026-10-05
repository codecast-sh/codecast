// Runs the local halves of codecast mods on this machine (plan pl-839). The
// daemon starts this once. Every half runs in its own Bun Worker, and only at
// a version a person approved on this device (`cast mod approve`, which needs
// a terminal): a new push changes the hash and the half stops until approved
// again. The runner relays the half's logs to `cast mod logs` and hands it the
// calls the mod's UI makes ($.local.call).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";

export type Approval = { hash: string; at: number };

function modsDir(): string {
  return path.join(process.env.CODECAST_DIR || defaultConfigDir(), "mods");
}

function approvalsFile(): string {
  return path.join(modsDir(), "approved.json");
}

export function readApprovals(): Record<string, Approval> {
  try { return JSON.parse(fs.readFileSync(approvalsFile(), "utf8")); } catch { return {}; }
}

export function writeApproval(name: string, hash: string | null): void {
  const all = readApprovals();
  if (hash) all[name] = { hash, at: Date.now() };
  else delete all[name];
  fs.mkdirSync(modsDir(), { recursive: true });
  fs.writeFileSync(approvalsFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

type LocalMod = { id: string; name: string; title?: string; rev: number; enabled: boolean; local_hash: string; local_code: string; manifest: unknown };
type Running = { hash: string; worker: Worker; ready: boolean; calls: Map<string, (r: { result?: unknown; error?: string }) => void> };

export type LocalRunnerDeps = {
  endpoint: () => { siteUrl: string; apiToken: string } | null;
  log: (message: string) => void;
  castBin?: string;
};

const SYNC_MS = 30_000;
const CALL_POLL_MS = 2_000;

export function startLocalMods(deps: LocalRunnerDeps): { stop: () => void } {
  const running = new Map<string, Running>();
  const logBuffer = new Map<string, { level: string; text: string }[]>();
  const device = os.hostname().replace(/\.local$/, "");

  const post = async (urlPath: string, body: Record<string, unknown>) => {
    const ep = deps.endpoint();
    if (!ep) throw new Error("not logged in");
    const res = await fetch(`${ep.siteUrl}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: ep.apiToken, ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as any;
    if (json?.error) throw new Error(String(json.error));
    return json;
  };

  const queueLog = (name: string, level: string, text: string) => {
    const list = logBuffer.get(name) ?? [];
    list.push({ level, text });
    logBuffer.set(name, list.slice(-50));
  };

  const flushLogs = () => {
    for (const [name, entries] of logBuffer) {
      if (!entries.length) continue;
      logBuffer.set(name, []);
      post("/cli/mods/log", { name, entries }).catch(() => {});
    }
  };

  const stopOne = (name: string, reason: string) => {
    const r = running.get(name);
    if (!r) return;
    r.worker.terminate();
    for (const done of r.calls.values()) done({ error: `the local half stopped: ${reason}` });
    running.delete(name);
    deps.log(`[MODS] stopped ${name}: ${reason}`);
  };

  const startOne = (mod: LocalMod) => {
    const dir = path.join(modsDir(), "run");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${mod.name}-${mod.local_hash}.mjs`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, mod.local_code);
    const worker = new Worker(file);
    const entry: Running = { hash: mod.local_hash, worker, ready: false, calls: new Map() };
    running.set(mod.name, entry);
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as any;
      if (msg?.type === "log") queueLog(mod.name, msg.level, String(msg.text));
      else if (msg?.type === "ready") { entry.ready = true; queueLog(mod.name, "log", `[local] started on ${device} (${mod.local_hash})`); }
      else if (msg?.type === "failed") { queueLog(mod.name, "error", `[local] failed to start on ${device}: ${msg.error}`); stopOne(mod.name, "failed to start"); }
      else if (msg?.type === "result") { entry.calls.get(msg.id)?.(msg); entry.calls.delete(msg.id); }
    };
    worker.onerror = (ev: ErrorEvent) => queueLog(mod.name, "error", `[local] ${ev.message}`);
    const ep = deps.endpoint()!;
    worker.postMessage({ type: "init", name: mod.name, manifest: mod.manifest, siteUrl: ep.siteUrl, apiToken: ep.apiToken, deviceName: device, castBin: deps.castBin ?? "cast" });
    deps.log(`[MODS] started ${mod.name} (${mod.local_hash})`);
  };

  const sync = async () => {
    let mods: LocalMod[];
    try { mods = (await post("/cli/mods/local", {})).mods ?? []; } catch { return; }
    const approvals = readApprovals();
    const want = new Map(mods.filter((m) => m.enabled && approvals[m.name]?.hash === m.local_hash).map((m) => [m.name, m]));
    for (const [name, r] of running) {
      const next = want.get(name);
      if (!next) stopOne(name, approvals[name] ? "a new version waits for approval (cast mod approve)" : "turned off or not approved");
      else if (next.local_hash !== r.hash) stopOne(name, "a new version");
    }
    for (const [name, mod] of want) if (!running.has(name)) {
      try { startOne(mod); } catch (err) { deps.log(`[MODS] could not start ${name}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  };

  const pump = async () => {
    const names = [...running.entries()].filter(([, r]) => r.ready).map(([n]) => n);
    if (!names.length) return;
    let calls: { id: string; name: string; method: string; args: unknown }[];
    try { calls = (await post("/cli/mods/claim-calls", { names, device_name: device })).calls ?? []; } catch { return; }
    for (const c of calls) {
      const r = running.get(c.name);
      if (!r) { post("/cli/mods/finish-call", { id: c.id, error: "the local half is not running here" }).catch(() => {}); continue; }
      const timer = setTimeout(() => { r.calls.get(c.id)?.({ error: "the local half took longer than 5 minutes" }); r.calls.delete(c.id); }, 5 * 60_000);
      r.calls.set(c.id, (res) => {
        clearTimeout(timer);
        post("/cli/mods/finish-call", { id: c.id, result: res.result, error: res.error }).catch(() => {});
      });
      r.worker.postMessage({ type: "call", id: c.id, method: c.method, args: c.args });
    }
  };

  void sync();
  const syncTimer = setInterval(() => void sync(), SYNC_MS);
  const callTimer = setInterval(() => void pump(), CALL_POLL_MS);
  const logTimer = setInterval(flushLogs, 3_000);
  return {
    stop: () => {
      clearInterval(syncTimer); clearInterval(callTimer); clearInterval(logTimer);
      for (const name of [...running.keys()]) stopOne(name, "the daemon is stopping");
      flushLogs();
    },
  };
}
