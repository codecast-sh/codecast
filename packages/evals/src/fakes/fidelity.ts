import { createHash } from 'node:crypto';

import { stripAnsi } from '@platform/cli-kit/render';

import { answer, handlerOf } from './cast';
import type { Tree } from './cast/tree';
import { newWorld, type Role } from './cast/world';
import { applyPipe, type Capture } from './capture';

// How often the fake answers the way the real service did, on calls it never
// saw. Each held-out session's captured calls replay in order through a
// fresh world, so a session that created a task and then commented on it is
// asked the same two things in the same order. Ids the fake mints stand in
// for the ones prod minted (ct-96001 for ct-95433): later calls that name the
// prod id are rewritten to the fake's before they are asked, and a minted id
// compares as a placeholder in both answers. An id the call itself named must
// come back exactly.

/**
 * What prod adds from context the fake cannot know, each with why: removed
 * from both answers for the core score only, so the gap between exact and
 * core is the part of prod's answer that lives outside the calls.
 */
export const CONTEXT: Array<{ re: RegExp; to: string; why: string }> = [
  { re: /^\s*pinned state is \d+ messages? old[^\n]*\n?/gm, to: '', why: 'the pin age is counted server-side from the live transcript' },
  { re: /, arrives (?:now|at its next tool call|when its current turn ends|once [^\n]*|when [^\n]*)$/gm, to: '', why: 'the receipt says whether the target is idle or busy at that moment (and older CLIs print none)' },
  { re: / \(teammate's session\)/g, to: '', why: "who owns the target is the workspace's, not the call's" },
  { re: /^note no diff found for [^\n]*\n?/gm, to: '', why: "a handoff guide's hunks are read from the checkout's diff" },
  { re: /^ {2}(?:ladder: [^\n]*|holder: a role under a grant[^\n]*)\n?/gm, to: '', why: "a decision's ladder and holder are the org's routing" },
];

const ID = /\b(?:ct|tr|sd|pl|pj|op)-\d+\b|\bjx[0-9a-z]{5}\b|\bj1[0-9a-z]{30}\b/g;

/** Harness lines Claude Code appends to a Bash result: not the service's answer. */
const HARNESS_TAIL = /\n?Shell cwd was reset to [^\n]*\n?$/;

export const cleanOut = (s: string): string => stripAnsi(s).replace(HARNESS_TAIL, '').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');

/** An answer with each id the caller did not already know replaced by its order of appearance, and each id the fake stands in for named as prod's. */
function normalize(out: string, known: Set<string>, asProd: Map<string, string> = new Map()): { text: string; minted: string[] } {
  const minted: string[] = [];
  const text = out.replace(ID, (id) => {
    if (known.has(id)) return asProd.get(id) ?? id;
    let i = minted.indexOf(id);
    if (i < 0) i = minted.push(id) - 1;
    return `<new${i + 1}>`;
  });
  return { text, minted };
}

const dropContext = (s: string): string => CONTEXT.reduce((t, c) => t.replace(c.re, c.to), s);

/** Deterministic: a session is held out or not by its id alone, so a fake grown on train never saw a test call. */
export const heldOut = (session: string, share = 0.3): boolean => parseInt(createHash('sha256').update(session).digest('hex').slice(0, 8), 16) / 0xffffffff < share;

/** The calling session's own id, as a replay's world would know it: a session read by its id is that id; a local transcript's is the id its sends and pins name as theirs. */
export function selfOf(caps: Capture[]): string | undefined {
  const session = caps[0]?.session ?? '';
  if (/^jx[0-9a-z]{5}/.test(session)) return session.slice(0, 7);
  for (const c of caps) {
    const m = /\bfrom (jx[0-9a-z]{5})\b/.exec(c.out) ?? /pinned the state of (jx[0-9a-z]{5})/.exec(c.out);
    if (m) return m[1];
  }
  return undefined;
}

export interface CallScore {
  session: string;
  seq: number;
  at?: string;
  verb: string;
  argv: string[];
  answered: boolean;
  exact: boolean;
  core: boolean;
  /** Undefined when a pipe hid the exit code from the transcript. */
  exitAgrees?: boolean;
  real: string;
  fake: string;
}

export interface VerbScore {
  verb: string;
  n: number;
  answered: number;
  exact: number;
  core: number;
  exitN: number;
  exitAgree: number;
}

/** The modelled verb a call reaches, by its leading words. */
export function verbOf(argv: string[]): string | null {
  for (const n of [2, 1]) {
    const k = argv.slice(0, n).join(' ');
    if (handlerOf(k)) return k;
  }
  return null;
}

/** Replays one session's captured calls through a fresh fake and scores each call to a modelled verb. */
export interface Oracles {
  /** Whether the guard takes an argv for a read. */
  isRead?: (argv: string[]) => boolean;
  /** The fake to score: the one in src/fakes/cast unless a candidate is given (grow.ts). */
  answer?: typeof answer;
}

export function scoreSession(caps: Capture[], tree: Tree, seed: { roles?: Record<string, Role>; people?: Record<string, string> } = {}, oracles: Oracles = {}): CallScore[] {
  const isRead = oracles.isRead ?? (() => false);
  // Every target a real call named existed, so the world is open: the score is about answers, not about which ids exist.
  const w = newWorld({ self: selfOf(caps), roles: seed.roles, people: seed.people, open: true });
  const alias = new Map<string, string>();
  const prodOf = new Map<string, string>();
  const knownReal = new Set<string>();
  const knownFake = new Set<string>();
  const out: CallScore[] = [];
  const rewrite = (s: string) => s.replace(ID, (id) => alias.get(id) ?? id);
  for (const c of caps) {
    if (c.argv.includes('--help') || c.argv.includes('-h')) continue;
    const argv = c.argv.map(rewrite);
    const stdin = rewrite(c.stdin ?? '');
    for (const t of c.argv.join(' ').concat(' ', c.stdin ?? '').match(ID) ?? []) knownReal.add(t);
    for (const t of argv.join(' ').concat(' ', stdin).match(ID) ?? []) knownFake.add(t);
    knownReal.add(w.self);
    knownFake.add(w.self);
    const verb = verbOf(c.argv);
    const a = (oracles.answer ?? answer)(argv, stdin, w, tree);
    const real = cleanOut(c.out);
    const fake = a ? cleanOut(applyPipe(a.out, c.pipe)) : '';
    const nr = normalize(real, knownReal);
    const nf = normalize(fake, knownFake, prodOf);
    nr.minted.forEach((id, i) => {
      const mine = nf.minted[i];
      if (mine) {
        alias.set(id, mine);
        prodOf.set(mine, id);
      }
    });
    for (const id of nr.minted) knownReal.add(id);
    for (const id of nf.minted) knownFake.add(id);
    // A read the fake leaves to the record (a task it did not create) is the record's to answer, not a miss.
    if (!verb || (!a && isRead(c.argv))) continue;
    out.push({
      session: c.session,
      seq: c.seq,
      ...(c.at ? { at: c.at } : {}),
      verb,
      argv: c.argv,
      answered: !!a,
      exact: !!a && nr.text === nf.text,
      core: !!a && dropContext(nr.text) === dropContext(nf.text),
      ...(c.pipe || !a ? {} : { exitAgrees: (a.exit === 0) === (c.exit === 0) }),
      real,
      fake,
    });
  }
  return out;
}

export function byVerb(calls: CallScore[]): VerbScore[] {
  const m = new Map<string, VerbScore>();
  for (const c of calls) {
    const v = m.get(c.verb) ?? { verb: c.verb, n: 0, answered: 0, exact: 0, core: 0, exitN: 0, exitAgree: 0 };
    v.n++;
    if (c.answered) v.answered++;
    if (c.exact) v.exact++;
    if (c.core) v.core++;
    if (c.exitAgrees !== undefined) {
      v.exitN++;
      if (c.exitAgrees) v.exitAgree++;
    }
    m.set(c.verb, v);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
