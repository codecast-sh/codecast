import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Freeze, FreezeStore } from '@platform/evals';
import { fsFreezeStore } from '@platform/evals/fs';

import { containsSecrets } from '../../../cli/src/secretRedaction';
import { homePaths, publicFreezesDir } from '../paths';

// Two homes for freezes behind one store. A synthetic fixture's pointer is
// committed (packages/evals/freezes, the repo is public), so it passes through
// committedFreeze(), which keeps an allowlist of fields and refuses secrets.
// Every real moment's pointer lives in EVALS_HOME/freezes and never in git.

const ALLOWED: Record<string, true | string[]> = {
  id: true,
  name: true,
  createdAt: true,
  anchor: ['kind', 'id'],
  subject: ['id', 'kind', 'title'],
  asOf: true,
  trigger: ['type'],
  judge: true,
  notes: true,
  tags: true,
  meta: ['surface', 'visibility', 'snapshot'],
};

/** Every string in a value, with its path, for the secret and length checks. */
export function stringsIn(value: unknown, path = ''): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsIn(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => stringsIn(v, path ? `${path}.${k}` : k));
  return [];
}

/**
 * A freeze as it may be committed: allowlisted keys only (any other is refused
 * by name), `trigger.data` dropped, `subject.title` set to `<surface> <case>`
 * (the field `freeze list -q` searches), and no string a secret scan matches.
 */
export function committedFreeze<T extends Partial<Freeze>>(f: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (value === undefined) continue;
    const rule = ALLOWED[key];
    if (!rule) throw new Error(`a committed freeze cannot carry "${key}": only ${Object.keys(ALLOWED).join(', ')} are allowed`);
    if (rule === true || value === null) {
      out[key] = value;
      continue;
    }
    const nested: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (key === 'trigger' && k === 'data') continue;
      if (!rule.includes(k)) throw new Error(`a committed freeze cannot carry "${key}.${k}": ${key} allows ${rule.join(', ')}`);
      nested[k] = v;
    }
    out[key] = nested;
  }
  const meta = out.meta as { surface?: string; visibility?: string; snapshot?: string } | undefined;
  if (meta?.visibility !== 'public') throw new Error('only a public (fixture) freeze can be committed');
  const subject = out.subject as { id: string; kind: string; title: string } | undefined;
  if (subject) subject.title = `${meta.surface} ${String(meta.snapshot ?? '').replace(/^.*\/|\.json$/g, '')}`;
  for (const s of stringsIn(out)) if (containsSecrets(s.text)) throw new Error(`a committed freeze cannot carry a secret (at ${s.path})`);
  return out as T;
}

export interface CodecastFreezeStoreOptions {
  publicDir?: string;
  privateDir?: string;
  /** The criteria a new freeze gets when none was given. */
  defaultJudge?(input: Omit<Freeze, 'id' | 'createdAt'>): string | null;
}

const visibility = (f: Pick<Freeze, 'meta'>): string | undefined => (f.meta as { visibility?: string } | undefined)?.visibility;

/** A fixture freeze, committed to the public repo; anything else is a real moment and stays private. */
export const isPublicFreeze = (f: Pick<Freeze, 'meta'>): boolean => visibility(f) === 'public';

export function codecastFreezeStore(opts: CodecastFreezeStoreOptions = {}): FreezeStore {
  const pub = fsFreezeStore({ dir: opts.publicDir ?? publicFreezesDir() });
  const priv = fsFreezeStore({ dir: opts.privateDir ?? homePaths().freezes });

  const owner = async (id: string): Promise<{ store: FreezeStore; freeze: Freeze } | null> => {
    const p = await pub.get(id);
    if (p?.id === id) return { store: pub, freeze: p };
    const q = await priv.get(id);
    if (q?.id === id) return { store: priv, freeze: q };
    return null;
  };

  return {
    async create(input) {
      const withJudge = { ...input, judge: input.judge ?? opts.defaultJudge?.(input) ?? null };
      return isPublicFreeze(input) ? pub.create(committedFreeze(withJudge)) : priv.create(withJudge);
    },
    async list(filter) {
      const all = [...(await pub.list(filter)), ...(await priv.list(filter))];
      return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async get(ref) {
      const p = await pub.get(ref);
      const q = await priv.get(ref);
      if (p && q) {
        if (p.id === ref) return p;
        if (q.id === ref) return q;
        throw new Error(`freezes in both homes match ${ref}: ${p.id.slice(0, 8)} (public) and ${q.id.slice(0, 8)} (private); give more of the id`);
      }
      return p ?? q;
    },
    async update(id, patch) {
      const hit = await owner(id);
      if (!hit) throw new Error(`no freeze ${id}`);
      if (hit.store === pub) committedFreeze({ ...hit.freeze, ...patch });
      return hit.store.update(id, patch);
    },
    async remove(id) {
      const hit = await owner(id);
      return hit ? hit.store.remove(id) : false;
    },
  };
}

const CONVEX_ID = /\b[a-z0-9]{32}\b/;

/**
 * What freezes.guard.test.ts enforces on packages/evals (the repo is public):
 * every committed freeze passes committedFreeze, is public and synthetic, and
 * points at a committed fixture; nothing under freezes/ or fixtures/ carries a
 * secret or a Convex document id; a freeze's judge stays under 1000
 * characters and its other strings under 300. Returns one line per problem.
 */
export function auditPublicTree(pkgRoot: string): string[] {
  const problems: string[] = [];
  const files = (dir: string) => (existsSync(join(pkgRoot, dir)) ? [...new Bun.Glob('**/*').scanSync({ cwd: join(pkgRoot, dir), onlyFiles: true, dot: true })].filter((f) => f !== '.gitkeep').map((f) => `${dir}/${f}`) : []);
  for (const rel of [...files('freezes'), ...files('fixtures')]) {
    const text = readFileSync(join(pkgRoot, rel), 'utf8');
    if (containsSecrets(text)) problems.push(`${rel}: carries a secret`);
    const id = CONVEX_ID.exec(text);
    if (id) problems.push(`${rel}: looks like a Convex document id (${id[0].slice(0, 6)}…)`);
    if (!rel.startsWith('freezes/')) continue;
    let f: Freeze;
    try {
      f = JSON.parse(text) as Freeze;
    } catch {
      problems.push(`${rel}: not JSON`);
      continue;
    }
    try {
      committedFreeze(structuredClone(f));
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
    if (f.subject?.kind !== 'synthetic') problems.push(`${rel}: subject.kind is ${f.subject?.kind}, not synthetic`);
    const snapshot = (f.meta as { snapshot?: string } | undefined)?.snapshot ?? '';
    if (!snapshot.startsWith('fixtures/') || snapshot.includes('..') || !existsSync(join(pkgRoot, snapshot))) problems.push(`${rel}: meta.snapshot "${snapshot}" is not a committed fixture`);
    if ((f.judge ?? '').length > 1000) problems.push(`${rel}: judge is ${(f.judge ?? '').length} characters (limit 1000)`);
    for (const s of stringsIn({ ...f, judge: undefined })) if (s.text.length > 300) problems.push(`${rel}: ${s.path} is ${s.text.length} characters (limit 300)`);
  }
  return problems;
}
