// A command station: a script the run's shell expands and runs, and the
// record every node's result lands in.
import { constants as osConstants } from "node:os";
import { spawn } from "../proc.js";
import { lineCommandEnv } from "../lineProfile.js";
import { c } from "../colors.js";
import { extractJsonOutput, lookupContextVar } from "./condition";
import { keepEnds } from "./keepEnds";
import { outputSummary } from "./runFailure";
import { STATION_KILL_GRACE_MS, endGroupLeftovers, endStation, endStationsOnExit, readStationProcs, reapDeadRunnerStations, recordStations, type StationProc } from "./stationProcs";
import type { NodeOutcome, WorkflowNode } from "./types";

// One $name as both expanders read it. `$human_message` is the gate note,
// empty when there is none, so a script can test it without tripping on an
// unset `$human.message` (which the shell would read as `$human`). A node's
// `$<id>.output` reads empty for the same reason when the node left none (a
// hand that never spawned).
export function contextVar(context: Record<string, string>, key: string): string | undefined {
  if (key === "human_message") return context["human.message"] ?? "";
  if (key.endsWith(".output") || key.endsWith(".summary")) return lookupContextVar(context, key) ?? "";
  return lookupContextVar(context, key);
}


// Every node's result lands under `<id>.output` (capped for prompts, both ends kept). When the
// result is JSON, or ends in a fenced json block, the parsed value is kept
// whole under `<id>.json` so `$<id>.json.<path>` and conditions can read its
// fields past the output cap.
const NODE_JSON_CAP = 64_000;
export function recordNodeOutput(context: Record<string, string>, nodeId: string, text: string, jsonSource = text): void {
  context[`${nodeId}.output`] = keepEnds(text, 4000);
  const parsed = extractJsonOutput(jsonSource);
  context[`${nodeId}.summary`] = outputSummary(text, parsed);
  const json = parsed === undefined ? undefined : JSON.stringify(parsed);
  if (json !== undefined && json.length <= NODE_JSON_CAP) context[`${nodeId}.json`] = json;
  else delete context[`${nodeId}.json`];
}

// $var in a script expands like $var in a prompt, but each value is quoted
// for the place it lands, so a task title with shell metacharacters stays
// data: single-quoted in bare words, backslash-escaped inside "...", and
// with its own quotes escaped inside '...'. A single-quoted value inside
// double quotes would keep its quotes ("origin/$default_branch" read as the
// ref origin/'main', and the line's red check fell back to a stale local
// main). `$(` and `${` are left to the shell (no \w follows the `$`).
// A dotted name ($scan.json.count) expands when the whole name resolves;
// otherwise only its first word does and the rest stays literal text. A name
// none of whose words resolve is left to the shell, and listed in `unresolved`.
export function expandScriptVars(script: string, context: Record<string, string>, unresolved?: string[]): string {
  const resolve = (key: string): { value: string; rest: string } | null => {
    const parts = key.split(".");
    for (let n = parts.length; n >= 1; n--) {
      const value = contextVar(context, parts.slice(0, n).join("."));
      if (value !== undefined) return { value, rest: parts.slice(n).map(p => `.${p}`).join("") };
    }
    return null;
  };
  // The shell's quoting as it stands at each `$`: a stack of bare (the top
  // level and every `$(`, counting its own parentheses), "..." and '...'.
  type Frame = { q: "bare"; parens: number } | { q: "dq" } | { q: "sq" };
  const stack: Frame[] = [{ q: "bare", parens: 0 }];
  const quoted = (q: Frame["q"], value: string) =>
    q === "dq" ? value.replace(/[\\"$`]/g, "\\$&")
    : q === "sq" ? value.replace(/'/g, `'\\''`)
    : `'${value.replace(/'/g, `'\\''`)}'`;
  let out = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const top = stack[stack.length - 1];
    if (top.q === "sq") {
      if (ch === "'") stack.pop();
    } else if (ch === "\\") {
      out += script.slice(i, i + 2);
      i++;
      continue;
    } else if (ch === "$" && script[i + 1] === "(") {
      stack.push({ q: "bare", parens: 0 });
      out += "$(";
      i++;
      continue;
    } else if (ch === '"') {
      if (top.q === "dq") stack.pop();
      else stack.push({ q: "dq" });
    } else if (top.q === "bare") {
      if (ch === "'") stack.push({ q: "sq" });
      else if (ch === "(") top.parens++;
      else if (ch === ")" && stack.length > 1 && top.parens-- === 0) stack.pop();
      else if (ch === "#" && (i === 0 || /\s/.test(script[i - 1]))) {
        const end = script.indexOf("\n", i);
        out += script.slice(i, end === -1 ? undefined : end);
        i = end === -1 ? script.length : end - 1;
        continue;
      }
    }
    if (ch === "$") {
      const name = /^\w+(?:\.\w+)*/.exec(script.slice(i + 1))?.[0];
      const hit = name ? resolve(name) : null;
      if (hit) {
        out += quoted(top.q, hit.value) + hit.rest;
        i += name!.length;
        continue;
      }
      if (name) unresolved?.push(name);
    }
    out += ch;
  }
  return out;
}

/**
 * The results a script reads ($pr.json.number) of stations `stations` does not have and the run holds nothing for:
 * the shell would get them as text (".json.number"). A station of the graph that has not run yet is not among them:
 * its placeholder still goes through, and a script may read that as no value (Union's onefix intent gate reads
 * $editor.json.founder for a change the Editor never read).
 */
export function absentStationReads(unresolved: string[], stations: { has(id: string): boolean }): string[] {
  return [...new Set(unresolved.filter((name) => /^\w+\.json\.\w/.test(name) && !stations.has(name.split(".")[0])))];
}

// The exit code an edge routes on. A script the timeout killed has no status
// of its own, and neither has one a signal took: recording those as 0 let
// `exit_code` edges read a timeout as a clean run. A timeout is 124, as
// timeout(1) reports it; any other signal is 128 + its number, as a shell does.
export function stationExitCode(result: { status: number | null; signal?: NodeJS.Signals | null; timedOut: boolean }): number {
  if (result.timedOut) return 124;
  if (result.status !== null) return result.status;
  return 128 + ((result.signal && osConstants.signals[result.signal]) || 0);
}

// The stations running now: each one's process group, with the processes it
// has as last read. A station's script runs in a group of its own, which
// nothing ends when the runner does: a daemon restart stopped the runners on
// Union's line-1 and left their Queue station's poller running under init for
// hours, beside the one each resumed run started (Nov 15). A resumed run runs
// its station again, so a station still running when its runner exits ends
// with it (TERM first, so a trap can clean up), and a runner that dies by
// SIGKILL leaves its stations' processes on disk for the next station to end
// (stationProcs.ts). That record is read again at the station's start and on
// every tick, so it holds what the station started since.
const runningGroups = new Map<number, { graceMs: number; procs: StationProc[]; reading: boolean }>();
const recordRunning = () => recordStations([...runningGroups].map(([pgid, { procs }]) => ({ pgid, procs })));
function rereadStation(group: number): void {
  const station = runningGroups.get(group);
  if (!station || station.reading || process.platform === "win32") return;
  station.reading = true;
  void readStationProcs(group, station.procs)
    .then((procs) => { station.procs = procs; }, () => {})
    .finally(() => { station.reading = false; if (runningGroups.get(group) === station) recordRunning(); });
}
let endsWithRunner = false;
function endWithRunner(group: number, graceMs: number): void {
  runningGroups.set(group, { graceMs, procs: [], reading: false });
  recordRunning();
  rereadStation(group);
  if (endsWithRunner) return;
  endsWithRunner = true;
  process.on("exit", () => {
    if (!runningGroups.size) return;
    if (process.platform === "win32") {
      for (const group of runningGroups.keys()) try { process.kill(group, "SIGTERM"); } catch {}
    } else endStationsOnExit(runningGroups.keys(), Math.max(...[...runningGroups.values()].map((g) => g.graceMs)));
    runningGroups.clear();
    recordRunning();
  });
}
function stationEnded(group: number): void {
  if (runningGroups.delete(group)) recordRunning();
}

/**
 * What a station watches while its script runs: `ended` says whether its run
 * ended elsewhere (a person cancelled it on the web), looked at every
 * `everyMs`, which is also how often silence is checked and the station's
 * processes are read again for its record. `graceMs` is how long
 * its processes get between TERM and KILL when it is cut off (tests shorten it).
 * `silent` hears a station that printed nothing past its `silent=` bound,
 * while it still runs, so the runner can tell a person.
 */
export type StationWatch = { ended?: () => Promise<boolean>; everyMs?: number; graceMs?: number; silent?: (note: string) => void };

/** Seconds a station may print nothing before it is flagged (node `silent=`, 0 never). */
const SILENT_DEFAULT_S = 1800;

/**
 * How long a station may print nothing before it is flagged, in ms (0 never). A station that parks waits on
 * something outside it (a deploy going live, a guard's next round) and prints only when it lands, so only an
 * explicit `silent=` bounds it: the default put a false "printed nothing" note on every change waiting to deploy.
 */
export const silentBoundMs = (node: WorkflowNode): number => (node.silent ?? (node.parks ? 0 : SILENT_DEFAULT_S)) * 1000;
/**
 * How long a station whose script exited waits for its output pipes to close.
 * A process that left the station's group (setsid) can hold them for good, and
 * waiting on `close` alone hung the station with it.
 */
const PIPE_CLOSE_GRACE_MS = 2000;

const seconds = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);

/**
 * `env` is what the runner adds to the script's environment beyond the line's run values: its run's own session
 * (runner.ts stationEnv). `stations` is the run's graph: a script that reads a station's result the graph does not
 * have fails here, before it runs, rather than handing the shell the name as text (a Merge on a graph with no PR
 * station ran `--pr .json.number` and ended Not merged, ct-90556, Nov 25).
 */
export async function executeCommand(
  node: WorkflowNode,
  context: Record<string, string>,
  cwd: string,
  watch: StationWatch = {},
  env: Record<string, string> = {},
  stations?: { has(id: string): boolean },
): Promise<NodeOutcome> {
  const unresolved: string[] = [];
  const script = expandScriptVars(node.script!, context, unresolved);
  const absent = stations ? absentStationReads(unresolved, stations) : [];
  if (absent.length) {
    const ids = [...new Set(absent.map((name) => name.split(".")[0]))];
    const why = `${node.label || node.id} reads ${absent.map((name) => `$${name}`).join(", ")}, but this graph has no station ${ids.join(" or ")}, so it did not run`;
    console.log(`  ${c.red}✗ ${why}${c.reset}`);
    recordNodeOutput(context, node.id, why);
    delete context[`${node.id}.exit_code`];
    context["last_error"] = why;
    return "failure";
  }
  console.log(`${c.dim}  $ ${script.split('\n')[0]}${script.includes('\n') ? '...' : ''}${c.reset}`);
  const graceMs = watch.graceMs ?? STATION_KILL_GRACE_MS;
  void reapDeadRunnerStations(undefined, graceMs).catch(() => {});

  try {
    // A repo's check command (the line's verify station) outruns the old two
    // minute cap on most repos; a timeout read as a failed check and burned an
    // implement visit. Per node, in seconds.
    const timeoutMs = (node.timeout ?? 120) * 1000;
    const silentMs = silentBoundMs(node);
    type Result = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; stopped: boolean; notes: string[] };
    const result = await new Promise<Result>((resolve, reject) => {
      const child = spawn("bash", ["-c", script], {
        cwd,
        // A project's line command (line-profile.md LP2) names run values
        // ($run_dir, $task_id, ...) that its own shell expands.
        env: { ...process.env, ...lineCommandEnv(context), ...env },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so ending the station takes the script's
        // children with it. spawnSync's timeout sent one SIGTERM to bash
        // alone, and on CI the script sometimes ran to its end and passed anyway.
        detached: process.platform !== "win32",
      });
      const group = process.platform === "win32" ? undefined : child.pid;
      let stdout = "", stderr = "", timedOut = false, stopped = false, closed = false, done = false;
      const notes: string[] = [];
      let quietSince = Date.now(), flagged = false, looking = false;
      let ending: Promise<void> | null = null;
      // Every process of the station, the ones that left its group included (stationProcs.ts).
      const end = () => {
        ending ??= group ? endStation(group, graceMs) : Promise.resolve(void child.kill("SIGKILL"));
      };
      if (child.pid) endWithRunner(child.pid, graceMs);
      const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
      const tick = setInterval(() => {
        if (group) rereadStation(group);
        // A station that prints nothing for long is flagged, never cut off: its timeout is the bound.
        if (silentMs > 0 && !flagged && Date.now() - quietSince >= silentMs) {
          flagged = true;
          const note = `printed nothing for ${seconds(Date.now() - quietSince)}`;
          notes.push(note);
          const told = `${node.label || node.id} has ${note}; still running (timeout ${seconds(timeoutMs)})`;
          console.log(`  ${c.yellow}! ${told}${c.reset}`);
          watch.silent?.(told);
        }
        if (watch.ended && !looking && !ending) {
          looking = true;
          watch.ended().then((ended) => { if (ended && !done) { stopped = true; end(); } }, () => {}).finally(() => { looking = false; });
        }
        // A silence bound under the tick is checked as often as it asks.
      }, watch.everyMs ?? Math.min(30_000, silentMs || 30_000));
      const heard = () => { quietSince = Date.now(); flagged = false; };
      child.stdout!.on("data", (d) => { stdout += d; heard(); });
      child.stderr!.on("data", (d) => { stderr += d; heard(); });
      let onClose: (() => void) | null = null;
      child.on("close", () => { closed = true; onClose?.(); });
      const settle = () => { clearTimeout(timer); clearInterval(tick); if (child.pid) stationEnded(child.pid); };
      child.on("error", (err) => { done = true; settle(); reject(err); });
      child.on("exit", (status, signal) => {
        clearTimeout(timer);
        clearInterval(tick);
        // A script that ended on its own takes what it left in its group; one cut off takes everything it started.
        const cleanup = ending ?? (group ? endGroupLeftovers(group, graceMs) : Promise.resolve());
        void cleanup
          .then(() => new Promise<void>((r) => { if (closed) return r(); onClose = r; setTimeout(r, PIPE_CLOSE_GRACE_MS); }))
          .then(() => {
            done = true;
            settle();
            child.stdout!.destroy();
            child.stderr!.destroy();
            resolve({ status, signal, stdout, stderr, timedOut, stopped, notes });
          });
      });
    });

    const output = result.stdout + result.stderr
      + result.notes.map((n) => `\n${n}`).join("")
      + (result.timedOut ? `\ntimed out after ${timeoutMs / 1000}s` : "")
      + (result.stopped ? "\nstopped: the run ended" : "");
    if (output.trim()) {
      console.log(c.dim + keepEnds(output, 2000) + c.reset);
    }

    // A station that succeeded is what it printed to stdout; what it logged to stderr while it worked is its log,
    // shown above and never its result. A hold's wait narration ("line Evals are paused, so the run stays parked")
    // stayed in Eval wallet's output after the pause lifted, and the card the run wrote next said the tests were
    // paused (sd-2511, Nov 5). A failure keeps both, since a script says why it failed on either stream.
    const ok = result.status === 0 && !result.timedOut && !result.stopped;
    recordNodeOutput(context, node.id, ok ? result.stdout.trim() || result.stderr.trim() : output.trim(), result.stdout);
    context[`${node.id}.exit_code`] = String(stationExitCode(result));
    // What the runner noticed about a station that succeeded (silent=) rides beside its result, never in it: later
    // stations read `$<id>.output` as the station's own words. A failure's output carries the notes already.
    if (ok && result.notes.length) context[`${node.id}.notes`] = result.notes.join("\n");
    else delete context[`${node.id}.notes`];

    if (ok) {
      console.log(`  ${c.green}✓ success${c.reset}`);
      return "success";
    } else {
      console.log(`  ${c.red}✗ failed (${result.timedOut ? "timed out" : result.stopped ? "the run ended" : `exit ${result.status}`})${c.reset}`);
      context["last_error"] = keepEnds(output.trim(), 2000);
      return "failure";
    }
  } catch (err: any) {
    console.log(`  ${c.red}✗ error: ${err.message}${c.reset}`);
    recordNodeOutput(context, node.id, err.message);
    return "failure";
  }
}
