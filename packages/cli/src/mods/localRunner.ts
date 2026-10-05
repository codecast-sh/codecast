// Runs the local halves of codecast mods on this machine (plan pl-839). The
// daemon starts this once. Every half runs in its own Bun Worker, and only at
// a version a person approved on this device (`cast mod approve`, which needs
// a terminal): a new push changes the hash and the half stops until approved
// again. The runner relays the half's logs to `cast mod logs` and hands it the
// calls the mod's UI makes ($.local.call).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";

export type Approval = { hash: string; at: number };

/**
 * The identity of a local half: a hash of the exact code that would run.
 * Computed here from the code itself, never taken from the server, so an
 * approval names what runs and nothing else can borrow it.
 */
export function localHash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);
}

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

type LocalMod = { id: string; name: string; title?: string; rev: number; enabled: boolean; local_code: string; manifest: unknown };
type Running = { hash: string; worker: Worker; ready: boolean; hooks: string[]; calls: Map<string, (r: { result?: unknown; error?: string }) => void> };

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

  const startOne = (mod: LocalMod, hash: string) => {
    const ep = deps.endpoint();
    if (!ep) return;
    const dir = path.join(modsDir(), "run");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Written on every start, from the code whose hash was approved: never a file left from before.
    const file = path.join(dir, `${mod.name}-${hash}.mjs`);
    fs.writeFileSync(file, mod.local_code, { mode: 0o600 });
    const worker = new Worker(file);
    const entry: Running = { hash, worker, ready: false, hooks: [], calls: new Map() };
    running.set(mod.name, entry);
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as any;
      if (msg?.type === "log") queueLog(mod.name, msg.level, String(msg.text));
      else if (msg?.type === "ready") {
        entry.ready = true;
        entry.hooks = Array.isArray(msg.hooks) ? msg.hooks.map((h: any) => String(h?.event)) : [];
        queueLog(mod.name, "log", `[local] started on ${device} (${hash})`);
        ensureFleetWatch();
      }
      else if (msg?.type === "failed") { queueLog(mod.name, "error", `[local] failed to start on ${device}: ${msg.error}`); stopOne(mod.name, "failed to start"); }
      else if (msg?.type === "result") { entry.calls.get(msg.id)?.(msg); entry.calls.delete(msg.id); }
    };
    // A worker that dies is dropped, so the next sync starts it again.
    worker.onerror = (ev: ErrorEvent) => { queueLog(mod.name, "error", `[local] ${ev.message}`); stopOne(mod.name, "it crashed"); };
    worker.postMessage({ type: "init", name: mod.name, manifest: mod.manifest, siteUrl: ep.siteUrl, apiToken: ep.apiToken, deviceName: device, castBin: deps.castBin ?? "cast" });
    deps.log(`[MODS] started ${mod.name} (${hash})`);
  };

  const sync = async () => {
    let mods: LocalMod[];
    try { mods = (await post("/cli/mods/local", {})).mods ?? []; } catch { return; }
    const approvals = readApprovals();
    const want = new Map<string, { mod: LocalMod; hash: string }>();
    for (const m of mods) {
      if (!m.enabled || !m.local_code) continue;
      const hash = localHash(m.local_code);
      if (approvals[m.name]?.hash === hash) want.set(m.name, { mod: m, hash });
    }
    for (const [name, r] of running) {
      const next = want.get(name);
      if (!next) stopOne(name, approvals[name] ? "a new version waits for approval (cast mod approve)" : "turned off or not approved");
      else if (next.hash !== r.hash) stopOne(name, "a new version");
    }
    for (const [name, { mod, hash }] of want) if (!running.has(name)) {
      try { startOne(mod, hash); } catch (err) { deps.log(`[MODS] could not start ${name}: ${err instanceof Error ? err.message : String(err)}`); }
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

  // One watch of the fleet for every half that hooks session.state: `cast
  // sessions -w --json` prints a line per transition. Started when the first
  // such half is ready, restarted if it exits while one still listens.
  let fleet: ReturnType<typeof Bun.spawn> | null = null;
  const listening = () => [...running.values()].filter((r) => r.ready && r.hooks.includes("session.state"));
  function ensureFleetWatch(): void {
    if (fleet || !listening().length) return;
    const proc = Bun.spawn([deps.castBin ?? "cast", "sessions", "-w", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    fleet = proc;
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev?.event !== "transition" || !ev.id || !ev.to) continue;
          const payload = { id: String(ev.id), from: ev.from ?? null, to: String(ev.to), title: ev.title ?? undefined };
          for (const r of listening()) r.worker.postMessage({ type: "event", event: "session.state", payload });
        }
      }
      if (fleet === proc) fleet = null;
      if (!stopped && listening().length) setTimeout(ensureFleetWatch, 10_000);
    })();
  }
  let stopped = false;

  void sync();
  const syncTimer = setInterval(() => void sync(), SYNC_MS);
  const callTimer = setInterval(() => void pump(), CALL_POLL_MS);
  const logTimer = setInterval(flushLogs, 3_000);
  return {
    stop: () => {
      stopped = true;
      fleet?.kill();
      clearInterval(syncTimer); clearInterval(callTimer); clearInterval(logTimer);
      for (const name of [...running.keys()]) stopOne(name, "the daemon is stopping");
      flushLogs();
    },
  };
}
