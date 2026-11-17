#!/usr/bin/env bun
// Scores the fake beside this file (./cast) on the train and held-out
// splits of a capture set, and writes both as JSON to <out>. grow.ts runs it
// inside prompt-dry-run.ts --exec, in a scratch copy of this package whose
// cast/ holds a model's candidate, so code nobody vouches for never runs in
// the ./evals process. <out> carries a nonce the candidate never sees and
// stdout is never read, so a candidate cannot print a score of its own.
//
//   bun scoreSplits.ts <captures dir> <cli-tree.json> <roster.json> <from ISO time> <out>
import { readFileSync, writeFileSync } from 'node:fs';

import { readTree } from './cast/tree';
import { readCaptures } from './capture';
import { byVerb, heldOut, scoreSession } from './fidelity';
import { GUARD_CAST } from '../paths';

const [capturesDir, treeFile, rosterFile, from = '', out] = process.argv.slice(2);
if (!capturesDir || !treeFile || !rosterFile || !out) throw new Error('usage: scoreSplits.ts <captures dir> <cli-tree.json> <roster.json> <from> <out>');
const tree = readTree(treeFile);
if (!tree) throw new Error(`no command tree at ${treeFile}`);
const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
const seen = new Map<string, boolean>();
const isRead = (argv: string[]) => {
  const key = JSON.stringify(argv);
  if (!seen.has(key)) seen.set(key, Bun.spawnSync(['bash', GUARD_CAST, ...argv], { env: { PATH: process.env.PATH ?? '', DRY_RUN_CLASSIFY: '1' } }).stdout.toString().trim() === 'read');
  return seen.get(key)!;
};
const all = readCaptures(capturesDir).filter((s) => s.length);
const split = (held: boolean) => {
  const calls = all.filter((s) => heldOut(s[0]!.session) === held).flatMap((s) => scoreSession(s, tree, roster, { isRead })).filter((c) => (c.at ?? '') >= from);
  return byVerb(calls).reduce((a, v) => ({ n: a.n + v.n, core: a.core + v.core, exact: a.exact + v.exact }), { n: 0, core: 0, exact: 0 });
};
writeFileSync(out, JSON.stringify({ train: split(false), test: split(true) }));
