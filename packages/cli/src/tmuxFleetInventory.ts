/**
 * One listing pass per tmux server, shared by every fleet listing.
 *
 * Each agent session has a tmux server of its own (tmuxRoute.ts), so a fleet
 * listing costs one tmux client per server. The daemon runs half a dozen
 * listings on their own timers, each with its own format, and with ~100
 * servers that was ~27 tmux spawns a second on 2026-11-07. Every tmux call a
 * delivery makes waited behind them: typing a message into a fresh session
 * (~40 calls in a row) took 114 to 205 seconds at load 450.
 *
 * So a server is asked once for every listing in recent use, in one client
 * (`list-sessions -F A ; list-panes -a -F B ; ...`), and the answers serve
 * every listing asked of that server for FLEET_INVENTORY_TTL_MS (5s). Nothing a
 * caller can act on goes stale past that window: a server that appears is
 * asked fresh (it has no answers yet), and a tmux write this process sends to
 * a server drops that server's answers (invalidateFleetServer).
 */

// Measured against 200 servers on the six listings' real timers: a 2s window
// rarely spans two timers (101 clients per listing), 5s does (68 to 85, from
// ~170 with no inventory). Servers that appear are always asked fresh, so the
// window only delays changes another process makes inside a server.
export const FLEET_INVENTORY_TTL_MS = 5_000;
/** A listing nobody asked for in this long stops riding along in passes. */
const COMMAND_IDLE_MS = 10 * 60_000;
/** Each row of command i is tagged with this, so one client's output splits back by command. */
const tag = (i: number) => `@@ccinv${i}@@`;
const TAG_RE = /^@@ccinv(\d+)@@/;

type Answer = { ok: true; stdout: string } | { ok: false; error: unknown };
type Pass = { generation: number; at: number; keys: Set<string>; done: Promise<Map<string, Answer>> };
type Server = { generation: number; at: number; answers: Map<string, Answer>; pass?: Pass };
type Exec = (argv: string[]) => Promise<string>;

/** Errors that say the server itself did not answer: every command on it would fail the same way. */
function serverWideFailure(error: unknown): boolean {
  const e = error as { killed?: boolean; signal?: unknown; stderr?: unknown; message?: unknown } | null;
  if (e?.killed || e?.signal === "SIGKILL") return true;
  const text = `${typeof e?.stderr === "string" ? e.stderr : ""} ${String(e?.message ?? "")}`;
  return /no server running on |error connecting to |Connection refused|ETIMEDOUT/i.test(text);
}

/** A command can ride in a batch when its rows can be tagged and none of its words would split the batch. */
function batchable(cmd: string[]): boolean {
  const f = cmd.indexOf("-F");
  return f >= 0 && f + 1 < cmd.length && cmd.every((word) => word !== ";" && !word.endsWith(";"));
}

function tagged(cmd: string[], i: number): string[] {
  const f = cmd.indexOf("-F");
  return cmd.map((word, at) => (at === f + 1 ? tag(i) + word : word));
}

/** Split one client's tagged output back into each command's own stdout. */
export function splitBatchOutput(stdout: string, count: number): string[] {
  const rows: string[][] = Array.from({ length: count }, () => []);
  let current: string[] | null = null;
  for (const line of stdout.split("\n")) {
    const m = line.match(TAG_RE);
    if (m && Number(m[1]) < count) {
      current = rows[Number(m[1])];
      current.push(line.slice(m[0].length));
    } else if (current && line !== "") {
      // A value with a newline in it continues the row above.
      current[current.length - 1] += `\n${line}`;
    }
  }
  return rows.map((r) => (r.length ? `${r.join("\n")}\n` : ""));
}

export class FleetInventory {
  private servers = new Map<string, Server>();
  private commands = new Map<string, { cmd: string[]; askedAt: number }>();
  /** Clients spawned for listings, for tests and the benchmark. */
  spawns = 0;

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = FLEET_INVENTORY_TTL_MS) {}

  /** `cmd` (no server flags) on `server`, from a pass no older than the TTL. `exec` runs one argv on that server. */
  async read(server: string, cmd: string[], exec: Exec): Promise<string> {
    const key = JSON.stringify(cmd);
    const now = this.now();
    this.commands.set(key, { cmd, askedAt: now });
    const state: Server = this.servers.get(server) ?? { generation: 0, at: -Infinity, answers: new Map() };
    this.servers.set(server, state);
    while (state.pass && (state.pass.generation !== state.generation || !state.pass.keys.has(key))) {
      await state.pass.done;
    }
    let answer = this.now() - state.at < this.ttlMs ? state.answers.get(key) : undefined;
    if (!answer) {
      const pass = state.pass && state.pass.generation === state.generation && state.pass.keys.has(key) ? state.pass : this.startPass(server, state, exec);
      answer = (await pass.done).get(key)!;
    }
    if (!answer.ok) throw answer.error;
    return answer.stdout;
  }

  /** A write to this server changed what it would list: nothing asked before it counts. */
  invalidate(server: string): void {
    const state = this.servers.get(server);
    if (!state) return;
    state.generation++;
    state.at = -Infinity;
    state.answers = new Map();
  }

  private startPass(server: string, state: Server, exec: Exec): Pass {
    const now = this.now();
    for (const [key, c] of this.commands) if (now - c.askedAt > COMMAND_IDLE_MS) this.commands.delete(key);
    for (const [name, s] of this.servers) if (!s.pass && now - s.at > 60_000 && name !== server) this.servers.delete(name);
    const cmds = [...this.commands.entries()];
    const pass: Pass = { generation: state.generation, at: now, keys: new Set(cmds.map(([k]) => k)), done: this.runPass(cmds, exec) };
    state.pass = pass;
    void pass.done.then((answers) => {
      if (state.pass === pass) state.pass = undefined;
      if (pass.generation !== state.generation) return;
      const kept = new Map([...answers].filter(([, a]) => a.ok));
      state.answers = kept;
      state.at = kept.size ? pass.at : -Infinity;
    });
    return pass;
  }

  private async runPass(cmds: Array<[string, { cmd: string[] }]>, exec: Exec): Promise<Map<string, Answer>> {
    const answers = new Map<string, Answer>();
    const one = async (key: string, cmd: string[]) => {
      this.spawns++;
      answers.set(key, await exec(cmd).then((stdout) => ({ ok: true as const, stdout }), (error) => ({ ok: false as const, error })));
    };
    const batch = cmds.filter(([, c]) => batchable(c.cmd));
    const alone = cmds.filter(([, c]) => !batchable(c.cmd));
    for (const [key, c] of alone) await one(key, c.cmd);
    if (batch.length === 1) await one(batch[0][0], batch[0][1].cmd);
    else if (batch.length > 1) {
      this.spawns++;
      const argv = batch.flatMap(([, c], i) => (i ? [";", ...tagged(c.cmd, i)] : tagged(c.cmd, i)));
      try {
        const outputs = splitBatchOutput(await exec(argv), batch.length);
        batch.forEach(([key], i) => answers.set(key, { ok: true, stdout: outputs[i] }));
      } catch (error) {
        // One command failing stops the rest of the chain, so each is asked
        // on its own, unless the server itself did not answer.
        if (serverWideFailure(error)) for (const [key] of batch) answers.set(key, { ok: false, error });
        else for (const [key, c] of batch) await one(key, c.cmd);
      }
    }
    return answers;
  }
}

/** The process's inventory: every routed fleet listing in this process shares it. */
export const fleetInventory = new FleetInventory();
