// Recorded Claude Code stream-json sessions: what the SDK wrote to `claude`
// and what `claude` wrote back, one JSON line each. The fake claude
// (fakeClaude.ts) replays them, so the SDK itself runs unmocked in tests.
//
// This repository is public. A recording never keeps thinking (signed or
// redacted blocks, deltas), the account's identity (email, organization), or
// the recording machine's home directory; scrub() is applied as each line is
// written, and the privacy test re-applies it to every checked-in file.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RecordedLine =
  | { from: "spawn"; args: string[] }
  | { from: "sdk"; message: any }
  | { from: "claude"; message: any };

export interface RecordingHeader {
  claudeCode: string | null;
  sdk: string;
  date: string;
  scenario: string;
}

export const FIXTURE_DIR = path.join(import.meta.dir, "..", "__fixtures__", "recordings");

const THINKING = new Set(["thinking", "thinking_delta", "redacted_thinking", "signature_delta"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const SCRUBBED_EMAIL = "user@example.com";
export const SCRUBBED_HOME = "/Users/user";

/** Claude Code's own commands. Anything else in a command, skill, agent or plugin list is the recording user's. */
const BUILTIN_COMMANDS = new Set(["compact", "clear", "model", "context", "cost", "init", "review", "help", "memory", "config", "status", "usage", "effort"]);
const PERSONAL_LISTS = new Set(["agents", "skills", "plugins", "mcp_servers", "plugin_errors", "available_output_styles"]);
const commandName = (c: unknown) => (typeof c === "string" ? c : c && typeof c === "object" ? String((c as { name?: unknown }).name ?? "") : "");

/** The value with every private field dropped or replaced. Idempotent. */
export function scrub<T>(value: T, home: string = os.homedir()): T {
  const text = JSON.stringify(value, (key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (THINKING.has(v.type)) return undefined;
      if (v.type === "content_block_start" && v.content_block === undefined) return undefined;
      if (v.type === "content_block_delta" && v.delta === undefined) return undefined;
      if (v.type === "stream_event" && v.event === undefined) return undefined;
    }
    if (Array.isArray(v)) {
      if (PERSONAL_LISTS.has(key)) return [];
      if (key === "commands" || key === "slash_commands") return v.filter((c) => BUILTIN_COMMANDS.has(commandName(c)));
      return v.filter((item) => item !== undefined);
    }
    if (typeof v === "string") {
      if (key === "user_output_styles_dir" || key === "memory_paths") return SCRUBBED_HOME;
      if (key === "organization" || key === "organizationName" || key === "organization_name") return "Example Org";
      if (key === "organizationUuid" || key === "accountUuid" || key === "organization_uuid" || key === "account_uuid") return "00000000-0000-0000-0000-000000000000";
      let s = v.replace(EMAIL, SCRUBBED_EMAIL);
      if (home && home !== "/") s = s.split(home).join(SCRUBBED_HOME);
      return s;
    }
    return v;
  });
  // A thinking block inside an array leaves `null` where it stood.
  return JSON.parse(text, (_k, v) => (Array.isArray(v) ? v.filter((item) => item !== null) : v));
}

export function recordingPath(name: string, dir = FIXTURE_DIR): string {
  return path.join(dir, `${name}.jsonl`);
}

export function loadRecording(name: string, dir = FIXTURE_DIR): { header: RecordingHeader; lines: RecordedLine[] } {
  const file = name.endsWith(".jsonl") ? name : recordingPath(name, dir);
  const [head, ...rest] = fs.readFileSync(file, "utf-8").trim().split("\n");
  return { header: JSON.parse(head), lines: rest.map((l) => JSON.parse(l)) };
}

/** What `claude` answered to the SDK's initialize request. */
export function startupReply(lines: RecordedLine[]): any {
  const line = lines.find((l) => l.from === "claude" && l.message.type === "control_response");
  return line && line.from === "claude" ? line.message.response.response : undefined;
}
