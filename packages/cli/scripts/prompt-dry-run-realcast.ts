// The real CLI, run outside the sandbox with no sign-in: help and the command tree.
import * as fs from "node:fs";
import * as path from "node:path";
import { ctx } from "./prompt-dry-run-context.ts";

/**
 * The real CLI with no sign-in, outside the sandbox for the two things the
 * guard asks of it that never run a command: a command's --help and the
 * command tree. A dev checkout's cast is `bun main.ts`, which the closed
 * world cannot open, and a compiled one would run a bunfig.toml preload from
 * the agent's directory, so it runs here, in a directory the agent cannot
 * write, with an empty state directory and this process's own home.
 */
export async function cliNoSignIn(args: string[]): Promise<Response> {
  const { harnessDir, brokerCwdDefault } = ctx();
  const cast = realCast();
  if (!cast) return new Response("1\ndry run: no real cast on PATH\n");
  const state = path.join(harnessDir, "help-state");
  fs.mkdirSync(state, { recursive: true });
  const p = Bun.spawn([cast, ...args], { cwd: brokerCwdDefault, env: { PATH: process.env.PATH ?? "", HOME: harnessDir, CODECAST_DIR: state, CODECAST_NO_AUTO_UPDATE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return new Response(`${status}\n${out}${err}`);
}

/** A command's help: its words alone, each a plain command word, then --help, so nothing else the agent typed reaches the CLI. */
export async function cliHelp(words: string[]): Promise<Response> {
  if (words.length > 8 || !words.every((w) => /^[a-z][a-z0-9-]*$/.test(w))) return new Response("1\ndry run: help takes command words only\n");
  return cliNoSignIn([...words, "--help"]);
}

/** The first `cast` on PATH that is not the guard: the real CLI. */
export function realCast(): string | null {
  const { guardDir, agentGuardDir } = ctx();
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, "cast");
    if (dir && path.resolve(dir) !== guardDir && path.resolve(dir) !== agentGuardDir && fs.existsSync(p)) return p;
  }
  return null;
}
