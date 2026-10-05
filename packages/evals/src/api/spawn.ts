import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { REPO_ROOT } from '../paths';

// How the api child starts long work (a bisect, a shrink, a sweep): in a
// detached tmux session the founder can attach to, or, with no tmux, as a
// detached process. Either way everything the job prints lands in its log
// file, so the reason a job ended outlives its tmux window. Always an argv
// array: nothing a client sends ever reaches a shell.

/**
 * The eval tool a spawned command runs: the checkout's own entry, through the
 * bun running this child (launchd hands the daemon a bare PATH, so `bun` by
 * name may not resolve). CODECAST_EVALS_API_TOOL names another entry, for
 * tests.
 */
export const evalsTool = (): string[] => [process.execPath, process.env.CODECAST_EVALS_API_TOOL || join(REPO_ROOT, 'packages', 'evals', 'src', 'index.ts')];

/** The multiplayer sim runner (`bun run sim` in packages/web), and the dir it runs from. */
export const simRunner = (): { argv: string[]; cwd: string } => {
  const web = join(REPO_ROOT, 'packages', 'web');
  return { argv: [process.execPath, join(web, 'scripts', 'sim.ts')], cwd: web };
};

let tmuxKnown: boolean | null = null;
export function hasTmux(): boolean {
  tmuxKnown ??= spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  return tmuxKnown;
}

export interface Launched {
  /** The tmux session, or null when the work runs detached. */
  tmux: string | null;
  pid: number | null;
}

/** A path as one single-quoted shell word (tmux pipe-pane runs its command through sh). */
const shellWord = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Starts `argv` detached, its output appended to `log`. With tmux the
 * session opens on a placeholder, pipe-pane tees the pane into the log, and
 * only then does respawn-pane exec argv (tmux execs a multi-word command
 * without a shell), so not even a crash in the first millisecond is lost.
 * With no tmux the process writes the log itself.
 */
export function launch(name: string, argv: string[], o: { cwd: string; log: string }): Launched {
  mkdirSync(dirname(o.log), { recursive: true });
  if (hasTmux()) {
    const target = `=${name}:`;
    const run = (args: string[]) => spawnSync('tmux', args, { encoding: 'utf8' });
    const opened = run(['new-session', '-d', '-s', name, '-c', o.cwd, '--', 'sleep', '600']);
    if (opened.status !== 0) throw new Error(`tmux could not start ${name}: ${(opened.stderr || '').trim()}`);
    const piped = run(['pipe-pane', '-t', target, '-o', `cat >> ${shellWord(o.log)}`]);
    const started = piped.status === 0 ? run(['respawn-pane', '-k', '-t', target, '-c', o.cwd, '--', ...argv]) : piped;
    if (started.status !== 0) {
      run(['kill-session', '-t', `=${name}`]);
      throw new Error(`tmux could not start ${name}: ${(started.stderr || '').trim()}`);
    }
    return { tmux: name, pid: null };
  }
  const fd = openSync(o.log, 'a');
  try {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return { tmux: null, pid: child.pid ?? null };
  } finally {
    closeSync(fd);
  }
}

/** Whether a launched job is still running: its tmux session exists, or its process answers signal 0. */
export function stillRunning(l: Launched): boolean {
  if (l.tmux) return spawnSync('tmux', ['has-session', '-t', `=${l.tmux}`], { stdio: 'ignore' }).status === 0;
  if (!l.pid) return false;
  try {
    process.kill(l.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs the eval tool to its end and returns its stdout; throws with its stderr's tail on a nonzero exit. */
export async function runTool(args: string[], timeoutMs = 110_000): Promise<string> {
  const proc = Bun.spawn([...evalsTool(), ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`./evals ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim().split('\n').slice(-6).join(' | ') || 'no output'}`);
  return out;
}
