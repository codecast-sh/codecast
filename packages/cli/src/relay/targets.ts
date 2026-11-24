import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "../proc.js";
import { HerdrError, herdrRequest, herdrSocketPath } from "../herdr.js";

export type DeliveryTarget =
  | { kind: "herdr"; socket: string; pane: string }
  | { kind: "paseo"; agent_id: string };

export type DeliverResult =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "gone"; reason: string }
  | { kind: "transient"; reason: string };

export type Liveness =
  | { kind: "alive" }
  | { kind: "gone"; reason: string }
  | { kind: "unknown"; reason: string };

export type ExecResult = { code: number; stdout: string; stderr: string };

export type TargetTransport = {
  herdr: (socket: string, method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;
  exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  writeTemp: (content: string) => { file: string; remove: () => void };
};

export const HERDR_PROMPT_TIMEOUT_MS = 10_000;
export const HERDR_PROBE_TIMEOUT_MS = 3_000;
export const PASEO_SEND_TIMEOUT_MS = 15_000;
export const PASEO_PROBE_TIMEOUT_MS = 8_000;

const HERDR_GONE_CODES = new Set(["agent_not_found", "pane_not_found", "agent_pane_not_found"]);

export function detectDeliveryTarget(
  env: Record<string, string | undefined>,
  socketFallback: () => string = herdrSocketPath,
): DeliveryTarget | null {
  if (env.PASEO_AGENT_ID) return { kind: "paseo", agent_id: env.PASEO_AGENT_ID };
  if (env.HERDR_PANE_ID) return { kind: "herdr", pane: env.HERDR_PANE_ID, socket: env.HERDR_SOCKET_PATH || socketFallback() };
  return null;
}

function execResult(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1 << 20 }, (err: any, stdout: string, stderr: string) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

function writeTempFile(content: string): { file: string; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-relay-"));
  const file = path.join(dir, "prompt.txt");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const realTransport: TargetTransport = {
  herdr: (socket, method, params, timeoutMs) => herdrRequest(socket, method, params, timeoutMs),
  exec: execResult,
  writeTemp: writeTempFile,
};

export type TargetAdapter = {
  deliver(target: DeliveryTarget, text: string): Promise<DeliverResult>;
  probe(target: DeliveryTarget, sessionId: string): Promise<Liveness>;
};

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function paseoErrorCode(result: ExecResult): string | null {
  const body = parseJson(result.stdout) ?? parseJson(result.stderr);
  return typeof body?.error?.code === "string" ? body.error.code : null;
}

async function deliverHerdr(t: TargetTransport, target: Extract<DeliveryTarget, { kind: "herdr" }>, text: string): Promise<DeliverResult> {
  try {
    await t.herdr(target.socket, "agent.prompt", { target: target.pane, text }, HERDR_PROMPT_TIMEOUT_MS);
    return { kind: "ok" };
  } catch (err) {
    const code = err instanceof HerdrError ? err.code : "error";
    const reason = `herdr ${code}: ${err instanceof Error ? err.message : String(err)}`;
    if (code === "agent_blocked") return { kind: "blocked", reason };
    if (HERDR_GONE_CODES.has(code)) return { kind: "gone", reason };
    return { kind: "transient", reason };
  }
}

async function probeHerdr(t: TargetTransport, target: Extract<DeliveryTarget, { kind: "herdr" }>, sessionId: string): Promise<Liveness> {
  try {
    const res = await t.herdr(target.socket, "agent.get", { target: target.pane }, HERDR_PROBE_TIMEOUT_MS);
    const session = res?.agent?.agent_session;
    if (session?.kind === "id" && typeof session.value === "string" && session.value && session.value !== sessionId) {
      return { kind: "gone", reason: `pane ${target.pane} now hosts session ${session.value}` };
    }
    return { kind: "alive" };
  } catch (err) {
    const code = err instanceof HerdrError ? err.code : "error";
    const reason = `herdr ${code}: ${err instanceof Error ? err.message : String(err)}`;
    return HERDR_GONE_CODES.has(code) ? { kind: "gone", reason } : { kind: "unknown", reason };
  }
}

async function deliverPaseo(t: TargetTransport, target: Extract<DeliveryTarget, { kind: "paseo" }>, text: string): Promise<DeliverResult> {
  let temp: { file: string; remove: () => void } | null = null;
  try {
    temp = t.writeTemp(text);
    const result = await t.exec(
      "paseo",
      ["send", target.agent_id, "--behavior", "steer", "--no-wait", "--prompt-file", temp.file, "--json"],
      PASEO_SEND_TIMEOUT_MS,
    );
    const code = paseoErrorCode(result);
    if (code === "AGENT_NOT_FOUND") return { kind: "gone", reason: `paseo ${code}` };
    if (code || result.code !== 0) return { kind: "transient", reason: `paseo send failed: ${code ?? (result.stderr.trim().split("\n")[0] || `exit ${result.code}`)}` };
    return { kind: "ok" };
  } catch (err) {
    return { kind: "transient", reason: `paseo send: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    temp?.remove();
  }
}

async function probePaseo(t: TargetTransport, target: Extract<DeliveryTarget, { kind: "paseo" }>): Promise<Liveness> {
  try {
    const result = await t.exec("paseo", ["inspect", target.agent_id, "--json"], PASEO_PROBE_TIMEOUT_MS);
    if (paseoErrorCode(result) === "AGENT_NOT_FOUND") return { kind: "gone", reason: "paseo AGENT_NOT_FOUND" };
    const body = parseJson(result.stdout);
    if (body?.Archived === true) return { kind: "gone", reason: "paseo agent is archived" };
    return body && !body.error ? { kind: "alive" } : { kind: "unknown", reason: `paseo inspect: ${result.stderr.trim().split("\n")[0] || `exit ${result.code}`}` };
  } catch (err) {
    return { kind: "unknown", reason: `paseo inspect: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function createTargetAdapter(transport: TargetTransport = realTransport): TargetAdapter {
  return {
    deliver: (target, text) => (target.kind === "herdr" ? deliverHerdr(transport, target, text) : deliverPaseo(transport, target, text)),
    probe: (target, sessionId) => (target.kind === "herdr" ? probeHerdr(transport, target, sessionId) : probePaseo(transport, target)),
  };
}
