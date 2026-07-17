// `cast doctor`'s multi-client self-test section.
//
// For every INSTALLED client (its binary is on PATH) this runs a cheap, offline,
// model-free probe of the per-client machinery the daemon relies on, so a drift
// between a client's registry descriptor and the code that consumes it fails here
// — as a fast `cast doctor` red — instead of as a mystery in a live session.
//
// Sub-checks, none of which spend a model turn, touch the network, or need the
// daemon:
//   descriptor  the binary is on PATH and the transcript root resolves to a
//               directory that exists or can be created
//   readiness   the registry's promptReadyPattern is a real RegExp that MATCHES a
//               representative "prompt is ready" line for the client
//   resume      resumeCmd(<id>) constructs a non-empty command that references the
//               client binary (the seam a resume goes through)
//   parser      parseTranscriptFor(client, <synthetic fixture>) round-trips a
//               minimal transcript in the client's own format to user/assistant
//               ParsedMessages — the exact production parser the sync loop uses
//   watcher     for the jsonl-dir clients (claude/codex/gemini/pi) the REAL watcher
//               fires a "session" event when a synthetic transcript is written into
//               a throwaway root; for the sqlite clients (opencode/cursor) the watch
//               is a DB poll with no file event, so this is a structural check that
//               the store root resolves.
//
// This is deliberately a leaf module: it imports the parser, the two file watchers,
// and the shared registry — never daemon.ts (which is a separate, heavy bundle that
// can't be imported without side effects). That keeps the doctor fast and the check
// honest about what it can prove without a running agent.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AGENT_CLIENTS, type AgentClientId, type AgentClientDescriptor } from "@codecast/shared/contracts";
import { parseTranscriptFor } from "./parser.js";
import { SessionWatcher } from "./sessionWatcher.js";
import { TranscriptDirWatcher, transcriptDirWatcherConfig, expandTranscriptRoot } from "./transcriptDirWatcher.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A synthetic, minimal transcript per client — the smallest input the client's own
// parser accepts and returns a user+assistant pair for. Held inline (not read from a
// fixture file) because the doctor ships as a standalone binary with no test assets.
export interface ClientFixture {
  /** Parser input: one user turn + one assistant turn, in the client's format. */
  transcript: string;
  /** A line the client's promptReadyPattern must match (proves the pattern is
   *  meaningful, not merely a compilable RegExp). */
  readySample: string;
  /** For a jsonl watcher: the transcript filename to write under the throwaway
   *  root, relative to it. Absent for sqlite clients (no file-event watcher). */
  watchRelPath?: string;
}

const PROBE = "codecast doctor probe";
const uuid = () => randomUUID();

/** Fixtures are built per call so watcher filenames carry a fresh uuid (codex/pi
 *  key the session id off the filename's trailing uuid). */
export function clientFixture(id: AgentClientId): ClientFixture {
  switch (id) {
    case "claude":
      return {
        transcript:
          `{"type":"user","message":{"role":"user","content":${JSON.stringify(PROBE)}},"timestamp":"2026-01-01T00:00:00.000Z"}\n` +
          `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]},"timestamp":"2026-01-01T00:00:01.000Z"}\n`,
        readySample: "❯ ",
        // claude: <projectsRoot>/<projectDir>/<sessionId>.jsonl, depth 2. The project
        // dir must avoid the watcher's test-dir markers to be emitted.
        watchRelPath: path.join("doctor-probe-project", `${uuid()}.jsonl`),
      };
    case "codex":
      return {
        transcript:
          `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":${JSON.stringify(PROBE)}}]}}\n` +
          `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}}\n`,
        readySample: "> ",
        // codex: nested dated dirs; the session id is the filename's trailing uuid.
        watchRelPath: path.join("2026", "01", "01", `rollout-${uuid()}.jsonl`),
      };
    case "gemini":
      return {
        transcript: JSON.stringify({
          sessionId: "doctor",
          projectHash: "doctorhash",
          startTime: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:01.000Z",
          messages: [
            { id: "1", timestamp: "2026-01-01T00:00:00.000Z", type: "user", content: PROBE },
            { id: "2", timestamp: "2026-01-01T00:00:01.000Z", type: "gemini", content: "pong" },
          ],
        }),
        readySample: "gemini",
        // gemini: <projectHash>/chats/<sessionId>.json — the watcher requires the
        // parent dir to be `chats`.
        watchRelPath: path.join("doctorhash", "chats", `${uuid()}.json`),
      };
    case "opencode":
      return {
        transcript: JSON.stringify({
          info: { id: "ses_doctor" },
          messages: [
            { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: PROBE }] },
            { info: { id: "m2", role: "assistant", time: { created: 2 }, modelID: "big-pickle" }, parts: [{ type: "text", text: "pong" }] },
          ],
        }),
        readySample: "ctrl+p commands",
        // sqlite store — no file-event watcher, so no watch fixture.
      };
    case "pi":
      return {
        transcript:
          `{"type":"session","version":3,"id":"s","cwd":"/tmp"}\n` +
          `{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":${JSON.stringify(PROBE)}}}\n` +
          `{"type":"message","id":"b","parentId":"a","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}\n`,
        readySample: "0.0%/200k",
        // pi: <cwd-slug>/<ISO-ts>_<uuid>.jsonl, exactly one dir deep; the trailing
        // uuid is the session id.
        watchRelPath: path.join("--tmp-doctor--", `2026-01-01T00-00-00-000Z_${uuid()}.jsonl`),
      };
    case "cursor":
      return {
        transcript: `user:\n${PROBE}\nassistant:\npong\n`,
        readySample: "❯ ",
        // sqlite store — no file-event watcher.
      };
  }
}

export interface SubCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ClientProbeResult {
  id: AgentClientId;
  binary: string;
  installed: boolean;
  subChecks: SubCheck[];
  ok: boolean;
}

/** True if `name` resolves on PATH. Shared with doctor.ts (its tmux/node probes). */
export function hasBin(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf-8" });
  return r.status === 0 && !!r.stdout.trim();
}

/** The transcript root resolves to a directory that exists or could be created
 *  (its nearest existing ancestor is a directory). For sqlite clients the root is a
 *  .db FILE, so we test its containing directory. */
function transcriptRootUsable(descriptor: AgentClientDescriptor): { ok: boolean; detail: string } {
  const raw = descriptor.transcriptRoots[0];
  if (!raw) return { ok: false, detail: "no transcript root in descriptor" };
  const expanded = expandTranscriptRoot(raw);
  const target = descriptor.watcherKind === "sqlite" ? path.dirname(expanded) : expanded;
  if (fs.existsSync(target)) {
    return { ok: fs.statSync(target).isDirectory(), detail: raw };
  }
  // Not present yet — creatable if an existing ancestor is a directory.
  let ancestor = path.dirname(target);
  while (ancestor && ancestor !== path.dirname(ancestor) && !fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  const creatable = fs.existsSync(ancestor) && fs.statSync(ancestor).isDirectory();
  return { ok: creatable, detail: creatable ? `${raw} (creatable)` : `${raw} (unreachable)` };
}

/** Drive the client's REAL jsonl watcher against a throwaway root: start it, write
 *  the synthetic transcript, and resolve true if it emits a "session" event for that
 *  file within the timeout. Returns null for clients with no file-event watcher. */
export async function watcherFires(id: AgentClientId, fixture: ClientFixture, timeoutMs = 4000): Promise<boolean | null> {
  if (!fixture.watchRelPath) return null; // sqlite clients: no file-event watcher
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-watch-${id}-`));
  const filePath = path.join(root, fixture.watchRelPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // claude has its own SessionWatcher (projectsPath override); codex/gemini/pi share
  // the generic TranscriptDirWatcher (basePath override from the registry config).
  const watcher =
    id === "claude"
      ? new SessionWatcher(root)
      : new TranscriptDirWatcher(transcriptDirWatcherConfig(id as "codex" | "gemini" | "pi", root));

  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      watcher.on("session", (e: { filePath: string }) => {
        if (e.filePath === filePath) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      watcher.start();
      // Let the recursive watcher settle before the write (mirrors the watcher tests).
      sleep(250).then(() => fs.writeFileSync(filePath, fixture.transcript));
    });
  } finally {
    try { (watcher as { stop?: () => void }).stop?.(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

/** Run the full offline probe for one client. */
export async function probeClient(id: AgentClientId): Promise<ClientProbeResult> {
  const descriptor = AGENT_CLIENTS[id];
  const installed = hasBin(descriptor.binary);
  if (!installed) {
    return { id, binary: descriptor.binary, installed: false, subChecks: [], ok: true };
  }

  const fixture = clientFixture(id);
  const subChecks: SubCheck[] = [];

  // descriptor: binary present (already true) + transcript root usable.
  const root = transcriptRootUsable(descriptor);
  subChecks.push({ label: "descriptor", ok: root.ok, detail: root.detail });

  // readiness: the pattern is a RegExp that matches a representative ready line.
  const readyOk = descriptor.promptReadyPattern instanceof RegExp && descriptor.promptReadyPattern.test(fixture.readySample);
  subChecks.push({ label: "readiness", ok: readyOk, detail: readyOk ? undefined : `pattern ${descriptor.promptReadyPattern} did not match ${JSON.stringify(fixture.readySample)}` });

  // resume: constructs a non-empty command referencing the binary.
  let resumeCmd = "";
  try { resumeCmd = descriptor.resumeCmd("doctor-probe-id"); } catch {}
  const resumeOk = resumeCmd.trim().length > 0 && resumeCmd.includes(descriptor.binary);
  subChecks.push({ label: "resume", ok: resumeOk, detail: resumeOk ? undefined : `resumeCmd = ${JSON.stringify(resumeCmd)}` });

  // parser: round-trips the synthetic fixture to user/assistant messages.
  let parsedRoles: string[] = [];
  try { parsedRoles = parseTranscriptFor(id, fixture.transcript).map((m) => (m as { role: string }).role); } catch {}
  const parserOk = parsedRoles.includes("user") && parsedRoles.includes("assistant");
  subChecks.push({ label: "parser", ok: parserOk, detail: parserOk ? `${parsedRoles.length} msgs` : `roles=[${parsedRoles.join(",")}]` });

  // watcher: real file-event watcher fires (jsonl clients), or structural (sqlite).
  const fired = await watcherFires(id, fixture);
  if (fired === null) {
    subChecks.push({ label: "watcher", ok: root.ok, detail: "sqlite poll (structural)" });
  } else {
    subChecks.push({ label: "watcher", ok: fired, detail: fired ? undefined : "no session event on synthetic write" });
  }

  return { id, binary: descriptor.binary, installed: true, subChecks, ok: subChecks.every((c) => c.ok) };
}

/** Probe every registered client. Installed clients run the full matrix; the rest
 *  come back as installed:false (skipped, not failed). Clients run concurrently. */
export async function probeAllClients(): Promise<ClientProbeResult[]> {
  const ids = Object.keys(AGENT_CLIENTS) as AgentClientId[];
  return Promise.all(ids.map((id) => probeClient(id)));
}
