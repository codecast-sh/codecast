// Fakes shared by the cloud agent core tests: a provider that serves agents
// from a table, temp dirs cleaned after each test, and a polling wait.
import { afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLOUD_AGENT_PROVIDERS, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { CloudApiError } from "../cloudAgents/http.js";
import { MirrorTranscript } from "../cloudAgents/transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError, type CloudAgentAdapter, type CloudAgentMirror } from "../cloudAgents/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });
export function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-agents-core-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface FakeAgent { id: string; updatedAt: string; running?: boolean; repo?: string; children?: string[]; branch?: string; gitUnknown?: boolean; replies: string[] }
export interface FakeClient { calls: string[] }

/**
 * A provider that serves agents from a table: every mirror renders a prompt
 * and its replies, and records how often it was asked.
 */
export function fakeAdapter(agents: Record<string, FakeAgent>, opts: { key?: () => boolean; format?: number } = {}) {
  const client: FakeClient = { calls: [] };
  const adapter: CloudAgentAdapter<FakeClient, FakeAgent, { seen: number }> = {
    spec: FAKE_SPEC,
    mirrorFormat: opts.format ?? 1,
    client: () => (opts.key?.() ?? true ? client : CloudAgentSetupError.credentialsMissing(adapter)),
    loadData: (raw: any) => ({ seen: typeof raw?.seen === "number" ? raw.seen : 0 }),
    async listAgents(c) {
      c.calls.push("list");
      return { items: Object.values(agents).filter((a) => !a.id.includes("child")).map((a) => ({ id: a.id, updatedAtMs: Date.parse(a.updatedAt), version: a.updatedAt, active: !!a.running, agent: a })) };
    },
    async mirror(c, handle, known): Promise<CloudAgentMirror | null> {
      c.calls.push(`mirror ${handle.agentId}${known ? "" : " (unlisted)"}`);
      const a = known ?? agents[handle.agentId];
      if (!a) return null;
      handle.data().seen++;
      handle.save();
      const tx = new MirrorTranscript(Date.parse(T0), { notice: await handle.notice() });
      tx.user("p1", "hello");
      a.replies.forEach((r, i) => tx.assistant(`r${i}`, r));
      if (!a.running) tx.turnEnded();
      return {
        transcript: tx.toString(),
        title: `agent ${a.id}`,
        createdAtMs: Date.parse(T0),
        repoUrl: a.repo,
        version: a.updatedAt,
        running: !!a.running,
        git: a.gitUnknown ? undefined : a.branch ? { agentId: a.id, branch: a.branch } : null,
        children: (a.children ?? []).map((agentId) => ({ agentId, description: "a worker" })),
      };
    },
    async create(c, session, content) { c.calls.push(`create ${content} ${session.repoUrl ?? ""}`); return { agentId: "bc-new", url: "https://x/bc-new" }; },
    async followUp(c, agentId, content) {
      c.calls.push(`followUp ${agentId} ${content}`);
      if (content === "busy") throw new CloudAgentBusyError("Fake Cloud");
      if (content === "denied") throw new CloudApiError(401, undefined, "401");
      if (content === "no-repo") throw CloudAgentSetupError.repoUnreachable(adapter, undefined, "no access", "Give it access");
    },
    async cancel(c, agentId) {
      c.calls.push(`cancel ${agentId}`);
      if (agentId === "bc-broken") throw new Error("503");
      return agents[agentId]?.running ? "turn t1" : null;
    },
  };
  return { adapter, client };
}

/** Cursor's spec under its own directory and card copy; its ids still carry `bc-`. */
export const FAKE_SPEC: CloudAgentProviderSpec = {
  ...CLOUD_AGENT_PROVIDERS.cursor,
  label: "Fake Cloud",
  mirrorDir: "fake-cloud",
  credentialCards: { missing: "Fake Cloud needs a key.", rejected: "Fake Cloud rejected the key", holdReason: "waiting for a fake key" },
};

export const T0 = "2026-09-29T10:00:00.000Z";
export const NOW = () => Date.parse(T0) + 60_000;
