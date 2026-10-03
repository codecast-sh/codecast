import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { bareEntityIdRegex } from '@codecast/shared/entities';
import type { ConvoMessage, GateResult } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import type { Fixture } from '../adapters/resolver';
import { gate, type Captured, type SurfaceRequest } from '../surface';

// What changes-story and changes-edition share (docs/proposals/changes-page.md
// 7.9): the two code gates the spec names for both, and the capture of a real
// moment from a snapshot file.
//
// No access-checked read returns a story's gated inputs, so a real day is
// frozen from a file shaped like a fixture ({asOf, snapshot}) that holds what
// prod's builder read. The resolver stores it privately in EVALS_HOME; the file
// itself belongs outside the repo.

/** Who and what the gate kept out of the prompt: the leak gate's list. */
export interface Withheld {
  /** The session's short id. */
  session: string;
  /** Its owner's name. */
  owner: string;
  /** Why teamVisibleInputs() dropped it: private, a member at hidden or activity, another team. */
  reason: string;
  /** Distinctive words of its insight that must never reach a reply. */
  phrases: string[];
}

/** What every changes snapshot may carry beside the prompt's input. */
export interface LeakWorld {
  /** Everyone on the team. A name in the reply that the prompt never carries is a leak. */
  people?: string[];
  withheld?: Withheld[];
}

export const fileRefForm = (surface: string) => `${surface}@file:<path> freezes a real day from a snapshot file kept outside the repo ({asOf, snapshot}, the fixture shape)`;

/**
 * A real moment from a snapshot file. The resolver redacts it, stores it privately and hashes it.
 * `world` names the leak lists the surface's gate reads; a file without them would freeze with a
 * gate that passes a hidden member's name, so it is refused. An empty list is an honest answer.
 */
export function captureFromFile(surface: string, ref: string, refForms: string, world: (keyof LeakWorld)[]): Captured {
  if (!ref.startsWith('file:')) throw new UsageError(refForms);
  const path = resolve(ref.slice('file:'.length));
  if (!existsSync(path)) throw new UsageError(`no snapshot file ${path}`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<Fixture>;
  if (!file.snapshot || !file.asOf) throw new UsageError(`${path} needs {asOf, snapshot}, the fixture shape`);
  const missing = world.filter((k) => !Array.isArray((file.snapshot as LeakWorld)[k]));
  if (missing.length) throw new UsageError(`${path} needs snapshot.${missing.join(' and snapshot.')} for the no-leak gate (an empty list when there is none)`);
  const name = basename(path).replace(/\.json$/, '');
  return {
    snapshot: file.snapshot,
    subject: { kind: surface, id: name, title: `${surface} ${name}` },
    asOf: file.asOf,
    anchor: { kind: 'run', id: name },
    name: `${surface} ${name}`,
    meta: { source_file: path },
  };
}

export const EM_DASH = '—';

export const emDashGate = (text: string): GateResult =>
  gate('no-em-dash', !text.includes(EM_DASH), text.includes(EM_DASH) ? `an em dash in: ${text.slice(Math.max(0, text.indexOf(EM_DASH) - 60), text.indexOf(EM_DASH) + 20)}` : 'no em dash');

/** Object ids as prose carries them (jx7c6zk, ct-12, #412), lowercased. */
export function idsIn(text: string): string[] {
  const ids = [...text.matchAll(bareEntityIdRegex())].map((m) => m[0].toLowerCase());
  for (const m of text.matchAll(/(?<![\w#])#\d+\b/g)) ids.push(m[0]);
  return [...new Set(ids)];
}

/** `word` as a whole word. Names match by case, so the name Mark is not the verb mark. */
const mentions = (text: string, word: string, caseSensitive = false) =>
  new RegExp(`(?<![\\w])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, caseSensitive ? '' : 'i').test(text);

/** Every byte a request sends the model: what a reply may draw ids and names from. */
export const sentText = (req: SurfaceRequest): string => `${req.system ?? ''}\n${req.prompt}`;

/**
 * The leak gate (spec 7.9): the reply names no session, object or person the
 * prompt does not carry, and repeats nothing the team gate withheld. `prompt`
 * is every byte the model was sent (sentText); `reply` the text a reader would see.
 */
export function leakGate(prompt: string, reply: string, world: LeakWorld): GateResult {
  const seen = prompt.toLowerCase();
  const leaks: string[] = [];
  for (const id of idsIn(reply)) if (!seen.includes(id.toLowerCase())) leaks.push(`id ${id}`);
  const names = new Set([...(world.people ?? []), ...(world.withheld ?? []).map((w) => w.owner)]);
  for (const name of names) {
    for (const part of [name, ...name.split(/\s+/).filter((p) => p.length > 2)]) {
      if (mentions(reply, part, true) && !mentions(prompt, part, true)) {
        leaks.push(`person ${part}`);
        break;
      }
    }
  }
  for (const w of world.withheld ?? []) {
    if (mentions(reply, w.session)) leaks.push(`withheld session ${w.session}`);
    for (const p of w.phrases) if (mentions(reply, p)) leaks.push(`withheld phrase "${p}" (${w.reason})`);
  }
  const found = [...new Set(leaks)];
  return gate('no-leak', found.length === 0, found.length ? `the reply names what the prompt never carried: ${found.join('; ')}` : 'every id and name in the reply is in the prompt, and nothing withheld appears');
}

/** The prompt as the judge and the convo views read it, with what the gate withheld named after it. */
export function describePrompt(prompt: string, world: LeakWorld): ConvoMessage[] {
  const at = '2026-01-01T00:00:00.000Z';
  const msgs: ConvoMessage[] = [{ n: 1, id: 'prompt', at, channel: 'session', isGroup: false, direction: 'in', from: 'user', text: prompt }];
  if (world.withheld?.length) {
    const lines = world.withheld.map((w) => `- ${w.session} by ${w.owner} (${w.reason}): ${w.phrases.join(', ')}`);
    msgs.push({ n: 2, id: 'withheld', at, channel: 'session', isGroup: false, direction: 'in', from: 'user', text: `Kept out of the prompt by the team gate; none of it may appear in the reply:\n${lines.join('\n')}` });
  }
  return msgs;
}
