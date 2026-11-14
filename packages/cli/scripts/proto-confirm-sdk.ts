#!/usr/bin/env bun
// Stage A on the Claude SDK backend, the backend the false notices came from:
// ClaudeSdkBackend.deliver under deliveryRecordUuid(messageId, "codecast-sdk")
// with ledger.expect({ exactUuid }), exactly as daemon.ts trySdkDelivery does,
// then the daemon's parser and the ledger's stamp on the transcript.
// Isolation as claude-sdk-e2e.ts: private CLAUDE_CONFIG_DIR, scratch host dir,
// private ledger under CODECAST_DIR.
//
//   CODECAST_DIR=/tmp/proto-confirm-run/codecast bun packages/cli/scripts/proto-confirm-sdk.ts [case...]
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeSdkBackend, type ClaudeSdkBackendDeps } from "../src/claudeSdk/backend.js";
import type { SdkActivity } from "../src/claudeSdk/protocol.js";
import { isolatedEnv, loginToken } from "../src/subscriptionCall.js";
import { resolveClaudeInstall } from "../src/stableClaudeBinary.js";
import { claudeProjectDirName } from "../src/projectPathResolver.js";
import { parseSessionFile } from "../src/parser.js";
import { DeliveryEchoLedger, echoCandidatesOf, deliveryRecordUuid } from "../src/deliveryEchoLedger.js";
import { formatSessionMessage } from "@codecast/shared/contracts";

if (!process.env.CODECAST_DIR?.includes("proto-confirm")) { console.error("refusing: CODECAST_DIR must be a proto-confirm scratch path"); process.exit(2); }
const real = resolveClaudeInstall();
if (!real) throw new Error("claude is not installed");
const RUN = fs.realpathSync("/tmp/proto-confirm-run");
const scratch = fs.mkdtempSync(path.join(RUN, "sdk-"));
const configDir = path.join(scratch, "config");
const hostDir = path.join(scratch, "hosts");
for (const d of [configDir, hostDir]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, isolatedEnv({ configDir, token: process.env.PROTO_TOKEN || loginToken(), stripModelKeys: true }));
const ledger = new DeliveryEchoLedger(path.join(RUN, "ledger-sdk.sqlite"));

const activity = new Map<string, SdkActivity[]>();
let holdPermission: ((v: { behavior: "allow" }) => void) | null = null;
let permissionOpen = false;
const deps: ClaudeSdkBackendDeps = {
  log: (l) => { if (process.env.E2E_VERBOSE) console.error(`  ${l}`); },
  castArgv: () => [process.execPath, path.join(import.meta.dir, "..", "src", "main.ts")],
  shellPrefix: () => "",
  activity: (c, _s, a) => { activity.set(c, [...(activity.get(c) ?? []), a]); },
  permission: async (c, _s, _request, _settled, opened) => {
    opened(`card-${c}`);
    if (c.endsWith("perm")) { permissionOpen = true; return await new Promise((r) => { holdPermission = r; }); }
    return { behavior: "allow" };
  },
  turnError: (_c, _s, e) => console.error(`turn error ${e.kind}: ${e.message}`),
  stopped: () => {},
  tooOld: () => {},
  transcriptHas: async () => false,
  mayResume: async () => true,
  resumeAccount: async (_c, saved) => saved,
  resumeModelEffort: () => ({ model: [], effort: [] }),
  transcriptExists: () => false,
  sessionChanged: () => {},
};
const backend = new ClaudeSdkBackend(deps, hostDir);
const until = async (what: string, fn: () => unknown, ms = 120_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type S = { conv: string; sessionId: string; cwd: string; transcript: string };
async function start(name: string): Promise<S> {
  const conv = `proto-confirm-${name}`;
  const sessionId = randomUUID();
  const cwd = path.join(scratch, "proj", name);
  fs.mkdirSync(cwd, { recursive: true });
  await backend.start(conv, { conversationId: conv, sessionId, resume: false, cwd, executable: real!, args: ["--model", "haiku", "--permission-mode", "default", "--session-id", sessionId], env: { CODECAST_LAUNCH_TOKEN: "proto" } });
  return { conv, sessionId, cwd, transcript: path.join(configDir, "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`) };
}
const working = (s: S) => (activity.get(s.conv) ?? []).slice(-3).some((a) => a.status === "working");

/** trySdkDelivery's ledger record and send, for one message. */
async function deliver(s: S, label: string, body: string) {
  const messageId = `msg-${label}-${randomUUID().slice(0, 8)}`;
  const marker = `MARK${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const content = formatSessionMessage("jx75h6r", `${body} ${marker}`);
  const uuid = deliveryRecordUuid(messageId, "codecast-sdk");
  ledger.expect({ messageId, conversationId: s.conv, payload: content, exactUuid: uuid });
  let outcome = "";
  try { outcome = await backend.deliver(s.conv, messageId, content, uuid); } catch (e) { outcome = `threw: ${String(e).slice(0, 160)}`; ledger.forget(messageId); }
  return { messageId, marker, uuid, outcome };
}

async function settle(s: S, label: string, d: Awaited<ReturnType<typeof deliver>>, waitMs = 90_000) {
  const deadline = Date.now() + waitMs;
  let raw = "";
  while (Date.now() < deadline) {
    raw = fs.existsSync(s.transcript) ? fs.readFileSync(s.transcript, "utf8") : "";
    if (raw.split("\n").some((l) => l.includes(d.marker) && /"type":"(user|attachment)"/.test(l))) break;
    await sleep(500);
  }
  const rec = raw.split("\n").filter((l) => l.includes(d.marker) && /"type":"(user|attachment)"/.test(l)).map((l) => JSON.parse(l))[0];
  const shape = rec ? (rec.type === "attachment" ? `attachment:${rec.attachment?.type}` : "user") : "absent";
  const turns = parseSessionFile(raw);
  const stamped = ledger.stamp(s.conv, echoCandidatesOf(turns as any));
  const hit = stamped.find((m) => m.role === "user" && m.content.includes(d.marker));
  return {
    case: label, outcome: d.outcome, rawShape: shape,
    recordUuid: rec?.uuid ?? null, sourceUuid: rec?.attachment?.source_uuid ?? null, sentUuid: d.uuid,
    stampedIds: hit ? (hit.deliveryIds ?? []) : null, confirmed: ledger.echoed(d.messageId),
  };
}

const LOOP = "Run these as six separate Bash tool calls, one after another, never combined: `sleep 4; echo step 1`, `sleep 4; echo step 2`, `sleep 4; echo step 3`, `sleep 4; echo step 4`, `sleep 4; echo step 5`, `sleep 4; echo step 6`. If a message arrives while you work, acknowledge it in one line and keep going.";
async function busy(s: S) {
  await deliver(s, "setup", LOOP);
  await until("working", () => working(s));
  await sleep(5000);
}

const cases: Record<string, () => Promise<unknown[]>> = {
  async idle() { const s = await start("idle"); const d = await deliver(s, "idle", "Lead here, reply with one word: ok."); return [await settle(s, "idle", d)]; },
  async busy() { const s = await start("busy"); await busy(s); const d = await deliver(s, "busy", "Lead here, a note while you work."); return [await settle(s, "busy", d)]; },
  async multiline() { const s = await start("multi"); await busy(s); const d = await deliver(s, "multiline-busy", "Lead here.\n\nLine two.\n- a bullet\n- another\n\nLast line."); return [await settle(s, "multiline-busy", d)]; },
  async backtoback() { const s = await start("b2b"); await busy(s); const d1 = await deliver(s, "b2b-1", "Lead here, first of two."); const d2 = await deliver(s, "b2b-2", "Lead here, second of two."); return [await settle(s, "b2b-1", d1), await settle(s, "b2b-2", d2)]; },
  async permission() {
    const s = await start("perm");
    await deliver(s, "setup", "Use the Write tool to create the file notes.txt containing the word hello. Then reply done.");
    await until("permission open", () => permissionOpen);
    const d = await deliver(s, "permission", "Lead here, a note while you wait on a prompt.");
    await sleep(3000);
    holdPermission?.({ behavior: "allow" });
    return [await settle(s, "permission", d)];
  },
  async killed() {
    const s = await start("killed");
    await backend.stop(s.conv, { forget: true });
    const d = await deliver(s, "killed", "Lead here, this one never lands.");
    return [await settle(s, "killed", d, 10_000)];
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases);
const out: unknown[] = [];
try {
  for (const name of want) {
    try { const r = await cases[name]!(); out.push(...r); console.log(JSON.stringify(r)); }
    catch (e) { console.log(JSON.stringify([{ case: name, error: String(e).slice(0, 400) }])); }
  }
} finally {
  fs.writeFileSync(path.join(RUN, `stageA-sdk-${Date.now()}.json`), JSON.stringify(out, null, 2));
  for (const c of backend.conversations()) await backend.stop(c, { forget: true }).catch(() => {});
  process.exit(0);
}
