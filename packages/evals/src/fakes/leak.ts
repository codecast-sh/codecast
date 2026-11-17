import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from '../paths';

// What a grown verbs.ts must not carry into a public repository: anything it
// could only have learned from real data. The model writes the edit from
// misses.json (prod answers, other people's messages) and the train
// captures, so every token of its added lines that those hold, and the
// public tree does not, is a leak: an id, an @handle, a person's name, or a
// quoted string longer than 12 characters. Prod's own wording is in the
// CLI's source, so quoting it is no leak.

const ID = /\bjx[0-9a-z]{5}\b|\b(?:ct|tr|sd|pl|pj|op|cl)-\d+\b/g;
const HANDLE = /@[a-z][a-z0-9-]+/g;
const QUOTED = /'((?:[^'\\\n]|\\.){13,})'|"((?:[^"\\\n]|\\.){13,})"|`((?:[^`\\]|\\.){13,})`/g;

/** The lines `after` adds to `before`, as a multiset: a line moved within the file is not new. */
export function addedLines(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const l of before.split('\n')) left.set(l, (left.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after.split('\n')) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

/** The tokens of a line the scan weighs: ids, handles, and quoted strings, each template literal cut at its ${…} holes. */
export function tokensOf(line: string): string[] {
  const out = new Set<string>([...(line.match(ID) ?? []), ...(line.match(HANDLE) ?? [])]);
  for (const m of line.matchAll(QUOTED)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    for (const part of body.split(/\$\{[^}]*\}/)) if (part.trim().length > 12) out.add(part.trim());
  }
  return [...out];
}

/** Whether a token is in the public tree, the edited file itself excluded (`git grep -F`). */
export function inPublicTree(token: string, root = REPO_ROOT, exclude = 'packages/evals/src/fakes/cast/verbs.ts'): boolean {
  // Source spells a quote inside a string as \" or \', so the token is looked for that way too.
  const spellings = [...new Set([token, token.replace(/"/g, '\\"'), token.replace(/'/g, "\\'")])];
  return spellings.some((t) => spawnSync('git', ['-C', root, 'grep', '-q', '-F', '-e', t, '--', '.', `:!${exclude}`], { encoding: 'utf8' }).status === 0);
}

export interface Leak {
  line: string;
  token: string;
}

/**
 * Every token of the edit's added lines that the private data holds and the
 * public tree does not; `names` adds the roster's people, matched anywhere in
 * an added line. Empty when the edit carries nothing it could only have
 * learned from real data.
 */
export function scanEdit(before: string, after: string, privateText: string, names: string[] = [], isPublic: (t: string) => boolean = inPublicTree): Leak[] {
  const leaks: Leak[] = [];
  for (const line of addedLines(before, after)) {
    const tokens = new Set(tokensOf(line));
    for (const name of names) if (name.length > 3 && line.includes(name)) tokens.add(name);
    // A token the original file already held was already public: the edit moved it, it learned nothing.
    for (const token of tokens) if (!before.includes(token) && privateText.includes(token) && !isPublic(token)) leaks.push({ line: line.trim(), token });
  }
  return leaks;
}
