import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { splitShellCommand } from '@codecast/shared/contracts/permissionRules';

import { evalsHome } from '../paths';
import type { Role } from './cast/world';

// The record a fake is written from and graded against: every call an agent
// made to a service's CLI, with the answer the real service gave, in the
// order the session made them. Transcripts already hold all of it (a Claude
// Code session's jsonl on this machine, any team session through
// `cast read <id> --full --json`), so nothing new records anything. Real
// captures live in EVALS_HOME/fakes/captures, never in git.

/** One real call and the real answer. */
export interface Capture {
  session: string;
  /** The call's place in its session: a fake replays a session's calls in this order, so a create precedes the comment on it. */
  seq: number;
  at?: string;
  argv: string[];
  /** A heredoc's body, fed on stdin (`cast task comment ct-1 -t progress - <<'EOF'`). */
  stdin?: string;
  /** `| tail -N` / `| head -N` after the call: the agent saw only those lines, so a fake's answer is cut the same way before comparing. */
  pipe?: { cut: 'head' | 'tail'; lines: number };
  out: string;
  exit: number;
}

/** One tool use and its result, the shape both transcript sources reduce to. */
export interface ToolPair {
  /** The tool use id: a resumed session's transcript repeats its history, so the same call appears in several files. */
  id: string;
  command: string;
  result: string;
  isError: boolean;
  at?: string;
}

export const capturesDir = (root = evalsHome()): string => join(root, 'fakes', 'captures');

const HEREDOC_HEAD = /^([^\n]*?)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2([^\n]*)\n/;
const CUT = /^(head|tail)$/;

/** A result the harness wrote rather than the service: a blocked call, a missing approval, a lost result, the CLI updating itself instead of answering. */
const NOT_THE_SERVICE = /^(?:Auto-updating to v|<tool_use_error>|\[Tool result missing|Nobody is watching this session|Blocked:|The user doesn't want to proceed|Error: Request interrupted)/;

/** The lines of a `head`/`tail` cut, as the shell would print them. */
export function applyPipe(out: string, pipe: Capture['pipe']): string {
  if (!pipe) return out;
  const lines = out.replace(/\n$/, '').split('\n');
  const kept = pipe.cut === 'head' ? lines.slice(0, pipe.lines) : lines.slice(-pipe.lines);
  return kept.join('\n');
}

function cutOf(words: string[]): Capture['pipe'] | null {
  if (!CUT.test(words[0] ?? '')) return null;
  const rest = words.slice(1);
  const n = rest.length === 1 ? /^-(\d+)$/.exec(rest[0]!)?.[1] : rest.length === 2 && rest[0] === '-n' ? rest[1] : undefined;
  return n ? { cut: words[0] as 'head' | 'tail', lines: Number(n) } : null;
}

/**
 * The single call a Bash command makes to `program`, or null. Only commands a
 * fake can be graded on count: one call, optionally after `cd`, optionally
 * fed a heredoc, optionally cut by `head`/`tail`. Anything else (two calls in
 * one command, a pipe into another program, an expansion) mixes the
 * service's answer with something else.
 */
export function callOf(command: string, program = 'cast'): Pick<Capture, 'argv' | 'stdin' | 'pipe'> | null {
  let line = command.trim();
  let stdin: string | undefined;
  const h = HEREDOC_HEAD.exec(line);
  if (h) {
    // The body ends at the first line that is the terminator alone; anything after it is another command.
    const body = line.slice(h[0].length).split('\n');
    const end = body.findIndex((l) => l.trimEnd() === h[3]);
    if (end < 0 || body.slice(end + 1).some((l) => l.trim())) return null;
    line = `${h[1]}${h[4]}`;
    stdin = body.slice(0, end).join('\n') + '\n';
  }
  const split = splitShellCommand(line);
  if (!split) return null;
  const calls = split.filter((w) => w[0] === program);
  if (calls.length !== 1) return null;
  const at = split.indexOf(calls[0]!);
  if (split.slice(0, at).some((w) => w[0] !== 'cd')) return null;
  const after = split.slice(at + 1);
  if (after.length > 1) return null;
  const pipe = after.length ? cutOf(after[0]!) : undefined;
  if (pipe === null) return null;
  // `cmd | tail` and `cmd && tail` split alike; only a pipe cuts output, and a pipe means the command text has one.
  if (pipe && !/\|\s*(head|tail)\b/.test(line)) return null;
  return { argv: calls[0]!.slice(1), ...(stdin !== undefined ? { stdin } : {}), ...(pipe ? { pipe } : {}) };
}

/** A pair's answer: Claude Code prefixes a failed command's output with `Exit code N`. */
export function answerOf(result: string, isError: boolean): { out: string; exit: number } | null {
  if (NOT_THE_SERVICE.test(result.trimStart())) return null;
  const m = /^Exit code (\d+)\n?/.exec(result);
  if (m) return { out: result.slice(m[0].length), exit: Number(m[1]) };
  return { out: result, exit: isError ? 1 : 0 };
}

export function capturesFrom(session: string, pairs: ToolPair[], program = 'cast', seen = new Set<string>()): Capture[] {
  const out: Capture[] = [];
  for (const p of pairs) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const call = callOf(p.command, program);
    const answer = call && answerOf(p.result, p.isError);
    if (!call || !answer) continue;
    out.push({ session, seq: out.length, ...(p.at ? { at: p.at } : {}), ...call, ...answer });
  }
  return out;
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : '';

/** A Claude Code transcript's Bash calls paired with their results, in order. */
export function pairsFromJsonl(text: string): ToolPair[] {
  const uses = new Map<string, { command: string; at?: string }>();
  const pairs: ToolPair[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (c?.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string') uses.set(c.id, { command: c.input.command, at: e.timestamp });
      else if (c?.type === 'tool_result' && uses.has(c.tool_use_id)) {
        const u = uses.get(c.tool_use_id)!;
        pairs.push({ id: c.tool_use_id, command: u.command, result: textOf(c.content), isError: Boolean(c.is_error), at: u.at });
      }
    }
  }
  return pairs;
}

/** `cast read <id> --full --json` messages paired the same way. */
export function pairsFromRead(messages: any[]): ToolPair[] {
  const uses = new Map<string, { command: string; at?: string }>();
  const pairs: ToolPair[] = [];
  for (const m of messages) {
    for (const t of m.tool_calls ?? []) {
      if (t.name !== 'Bash') continue;
      let input: any = t.input;
      try {
        if (typeof input === 'string') input = JSON.parse(input);
      } catch {
        continue;
      }
      if (typeof input?.command === 'string') uses.set(t.id, { command: input.command, at: m.timestamp });
    }
    for (const r of m.tool_results ?? []) {
      const u = uses.get(r.tool_use_id);
      if (u) pairs.push({ id: r.tool_use_id, command: u.command, result: textOf(r.content), isError: Boolean(r.is_error), at: u.at });
    }
  }
  return pairs;
}

/** Every Claude Code transcript on this machine, subagents' included. */
export function localTranscripts(root = join(homedir(), '.claude', 'projects')): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir) || depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

async function readRange(id: string, range: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['cast', 'read', id, range, '--full', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/**
 * A session's calls through `cast read`, its newest `limit` messages. A read
 * from the end reaches back 500 lines; older pages go by line number, and a
 * session's line count is only exact in the answer to a read past its end.
 */
export async function remotePairs(id: string, limit: number): Promise<ToolPair[]> {
  const fail = (r: { out: string; err: string }) => new Error(`cast read ${id} failed: ${(r.err || r.out).trim().slice(0, 300)}`);
  if (limit <= 500) {
    const r = await readRange(id, `-${limit}:`);
    if (r.code !== 0) throw fail(r);
    return pairsFromRead(JSON.parse(r.out).messages ?? []);
  }
  const probe = await readRange(id, '999999999:999999999');
  const total = Number(/has (\d+) lines/.exec(probe.err + probe.out)?.[1] ?? NaN);
  if (!Number.isFinite(total)) throw fail(probe);
  const messages: any[] = [];
  for (let from = Math.max(1, total - limit + 1); from <= total; from += 500) {
    const r = await readRange(id, `${from}:${Math.min(total, from + 499)}`);
    if (r.code !== 0) throw fail(r);
    messages.push(...(JSON.parse(r.out).messages ?? []));
  }
  return pairsFromRead(messages);
}

export function writeCaptures(dir: string, session: string, captures: Capture[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`), captures.map((c) => JSON.stringify(c)).join('\n') + '\n');
}

/** Every captured session, its calls in order. */
export function readCaptures(dir = capturesDir()): Capture[][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Capture));
}

async function castJson(args: string[]): Promise<any> {
  const proc = Bun.spawn(['cast', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`cast ${args.join(' ')} exited ${code}`);
  return JSON.parse(out);
}

/**
 * Every role in the caller's teams by handle: its standing session and its
 * title, as `cast org ls` holds them. It is the world a replay's snapshot
 * reads (`org ls` is a frozen read), so seeding the fake with it uses nothing
 * from the answers being graded.
 */
export async function captureRoster(): Promise<Roster> {
  const roles: Record<string, Role> = {};
  const people: Record<string, string> = {};
  for (const team of (await castJson(['teams', '--json'])) as Array<{ id: string }>) {
    let org: any;
    try {
      org = await castJson(['org', 'ls', '--team', team.id, '--json']);
    } catch {
      continue;
    }
    const anchors = new Map<string, string>((org.anchors ?? []).map((a: any) => [a.anchor_id, a.short_id]));
    for (const r of org.roles ?? []) {
      const session = anchors.get(r.anchor_id);
      if (r.handle && session) roles[r.handle] = { session, title: r.name };
    }
    for (const p of org.people ?? []) if (p.handle && p.name) people[p.handle] = p.name;
  }
  return { roles, people };
}

/** The workspace a fake world is seeded with: its roles and its people. */
export interface Roster {
  roles: Record<string, Role>;
  people: Record<string, string>;
}
