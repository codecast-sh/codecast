/**
 * `cast sim record`: the simulator's screen to a video, in the background so
 * the agent can tap and type while it runs. `simctl io recordVideo` records
 * until it is sent SIGINT, then finishes the file; the pid and path live in a
 * small state file per simulator between `record start` and `record stop`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "../proc.js";
import { agentTempDir } from "../tempFiles.js";

interface RecordingState {
  pid: number;
  file: string;
  log: string;
}

function statePath(udid: string): string {
  return path.join(agentTempDir("sim"), `record-${udid}.json`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start recording; returns once simctl says the first frame is in. */
export async function startRecording(udid: string, file: string): Promise<{ file: string } | { error: string }> {
  const existing = readState(udid);
  if (existing && alive(existing.pid)) return { error: `already recording to ${existing.file}; \`cast sim record stop\` finishes it` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const log = `${statePath(udid)}.log`;
  const out = fs.openSync(log, "w");
  // h264 plays in browsers and the thread's player; simctl's default is hevc.
  const child = spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  if (!child.pid) return { error: "could not start simctl recordVideo" };
  child.unref();
  fs.writeFileSync(statePath(udid), JSON.stringify({ pid: child.pid, file, log } satisfies RecordingState));
  for (let waited = 0; waited < 15_000; waited += 250) {
    const text = fs.readFileSync(log, "utf-8");
    if (/Recording started/i.test(text)) return { file };
    if (!alive(child.pid)) {
      fs.rmSync(statePath(udid), { force: true });
      return { error: `recording stopped at once: ${text.trim().split("\n").pop() || "simctl exited"}` };
    }
    await sleep(250);
  }
  return { file };
}

/** Stop the recording and wait for simctl to finish writing the file. */
export async function stopRecording(udid: string): Promise<{ file: string; bytes: number } | { error: string }> {
  const state = readState(udid);
  if (!state) return { error: "nothing is recording on this simulator; `cast sim record start` begins" };
  if (alive(state.pid)) {
    process.kill(state.pid, "SIGINT");
    for (let waited = 0; waited < 20_000 && alive(state.pid); waited += 250) await sleep(250);
  }
  fs.rmSync(statePath(udid), { force: true });
  const bytes = fs.existsSync(state.file) ? fs.statSync(state.file).size : 0;
  if (!bytes) {
    const tail = fs.existsSync(state.log) ? fs.readFileSync(state.log, "utf-8").trim().split("\n").pop() : "";
    return { error: `the recording wrote no video${tail ? `: ${tail}` : ""}` };
  }
  return { file: state.file, bytes };
}

function readState(udid: string): RecordingState | null {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(udid), "utf-8")) as RecordingState;
    return typeof s.pid === "number" && typeof s.file === "string" ? s : null;
  } catch {
    return null;
  }
}
