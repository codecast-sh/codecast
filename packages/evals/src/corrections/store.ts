import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { homePaths } from '../paths';

// The corrections on file: one JSON per typed line under
// EVALS_HOME/corrections, with what triage and drafting made of it and the
// freeze it became. Real content, so never in git.

export type CorrectionStatus = 'candidate' | 'withheld' | 'not-behavior' | 'not-guidance' | 'drafted' | 'frozen' | 'dismissed';

export interface GuidanceDraft {
  /** What the test checks, short enough for a list. */
  title?: string;
  /** The rule the agent should have followed, in general words. */
  rule: string;
  /** What a person types to put a fresh agent at the same choice, self-contained. */
  request: string;
  /** Patterns over the first decisive action (GuidanceLabel). */
  want: string[];
  avoid: string[];
  /** One sentence: the behavior a correct reply shows. */
  criteria: string;
}

export interface Correction {
  /** `<conversation id>:<line>`, the full id (short ids collide), also the guidance ref. */
  id: string;
  conversation: string;
  line: number;
  messageId: string;
  at: string;
  title: string;
  said: string;
  /** What the agent did just before, as the triage read it. */
  before: string;
  status: CorrectionStatus;
  /** The agent habit triage read in the line. */
  habit?: string;
  /** Why triage or drafting set the status. */
  why?: string;
  draft?: GuidanceDraft;
  freezeId?: string;
  /** Pinned when it is frozen and never changed: a climb's rewriter reads only `train`, so a freeze a climb trained on can never be held out later. */
  split?: Split;
}

const dir = (): string => join(homePaths().root, 'corrections');
export type Split = 'train' | 'held-out';

/** The share of correction freezes held out from every climb. */
export const HOLD_OUT_SHARE = 0.35;

/** A correction's split, from its id alone, so it is the same whenever and wherever it is decided. */
export function splitFor(id: string): Split {
  const x = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) / 0x100000000;
  return x < HOLD_OUT_SHARE ? 'held-out' : 'train';
}

const fileOf = (id: string): string => join(dir(), `${id.replace(':', '-')}.json`);

/** A correction's id: the full conversation id and the line. */
export const correctionId = (conversation: string, line: number): string => `${conversation}:${line}`;

/** How a list shows one: the session's short id and the line (the full id is in --json). */
export const shortRef = (c: Pick<Correction, 'conversation' | 'line'>): string => `${c.conversation.slice(0, 7)}:${c.line}`;

export function loadCorrections(): Correction[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir(), n), 'utf8')) as Correction)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** One correction by its full id, `<session prefix>:<line>` when only one session matches, or its freeze id's prefix. */
export function loadCorrection(ref: string): Correction | null {
  const exact = fileOf(ref);
  if (existsSync(exact)) return JSON.parse(readFileSync(exact, 'utf8')) as Correction;
  const all = loadCorrections();
  const m = /^(.+):(\d+)$/.exec(ref);
  const hits = m ? all.filter((c) => c.conversation.startsWith(m[1]!) && c.line === Number(m[2])) : all.filter((c) => c.freezeId?.startsWith(ref));
  return hits.length === 1 ? hits[0]! : null;
}

export function saveCorrection(c: Correction): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(fileOf(c.id), `${JSON.stringify(c, null, 1)}\n`);
}
