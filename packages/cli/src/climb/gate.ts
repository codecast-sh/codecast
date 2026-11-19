// The product's eval gate, run by Guard under a time limit (flows.md FL10).
// A gate can hang with nothing left to wait for: Union's proof-tree.sh runs
// the eval over ssh on another machine, and on ct-97276's sixth run the
// remote process was gone while the local ssh waited three hours. A gate past
// its limit is stopped with its whole process group and reads as void (Hold
// checks again; it never passes), naming the command and its last output.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "../proc.js";
import { tryGit } from "./protect.js";

/** The limit when nothing declares one and no gate has run in this climb: twice the longest gate Union has needed (about an hour). */
export const GATE_LIMIT_DEFAULT_S = 2 * 60 * 60;

/**
 * How long one gate run may take: `[guard] timeout_s` in `.codecast/climb.toml`
 * as committed at the base, else twice the longest gate run this climb has
 * finished, else GATE_LIMIT_DEFAULT_S.
 */
export function gateLimitS(root: string, base: string, recentMs: readonly number[]): { s: number; from: "declared" | "recent" | "default" } {
  const text = tryGit(root, ["show", `${base}:.codecast/climb.toml`]);
  if (text) {
    try {
      const declared = (Bun.TOML.parse(text) as any)?.guard?.timeout_s;
      if (typeof declared === "number" && declared > 0) return { s: declared, from: "declared" };
    } catch {}
  }
  if (recentMs.length) return { s: Math.ceil((2 * Math.max(...recentMs)) / 1000), from: "recent" };
  return { s: GATE_LIMIT_DEFAULT_S, from: "default" };
}

export type GateRun = { code: number | null; timedOut: boolean; ms: number; tail: string };

/** Run the gate's command in its own process group, its output kept in `log` (and passed through); past `limitS` the whole group is stopped. */
export function runGate(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; limitS: number; log: string }): Promise<GateRun> {
  const started = Date.now();
  const out = fs.openSync(opts.log, "a");
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", out, out] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }, opts.limitS * 1000);
    const done = (code: number | null) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch {}
      let text = "";
      try { text = fs.readFileSync(opts.log, "utf8"); } catch {}
      process.stdout.write(text.slice(-20_000));
      resolve({ code, timedOut, ms: Date.now() - started, tail: tailLines(text) });
    };
    child.on("close", (code) => done(code));
    child.on("error", () => done(null));
  });
}

/** The last few lines of a command's output, for a report: what it was doing when it stopped. */
export const tailLines = (text: string, lines = 6, chars = 600) => {
  const t = text.trimEnd().split("\n").slice(-lines).join("\n");
  return t.length > chars ? `...${t.slice(-chars)}` : t || "(no output)";
};

export const gateLog = (dir: string) => path.join(dir, "gate.log");
