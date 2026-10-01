/**
 * A `FreezeStore` over a folder of JSON files: one file per freeze, named by
 * its id. Enough for a repo that keeps its evidence on disk beside its runs;
 * an app with a database implements the same interface over a table.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Freeze, FreezeStore } from '../model';

export function fsFreezeStore(opts: { dir: string }): FreezeStore {
  const path = (id: string) => join(opts.dir, `${id}.json`);
  const all = (): Freeze[] => {
    if (!existsSync(opts.dir)) return [];
    return readdirSync(opts.dir)
      .filter((n) => n.endsWith('.json'))
      .flatMap((n) => {
        try {
          return [JSON.parse(readFileSync(join(opts.dir, n), 'utf8')) as Freeze];
        } catch {
          return [];
        }
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  };
  const write = (f: Freeze) => {
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(path(f.id), JSON.stringify(f, null, 2));
  };
  return {
    async create(input) {
      const f: Freeze = { ...input, id: input.id ?? randomUUID(), createdAt: new Date().toISOString(), tags: input.tags ?? [] };
      write(f);
      return f;
    },
    async list(filter = {}) {
      const q = filter.q?.toLowerCase();
      return all().filter((f) => {
        if (filter.tag && !f.tags.includes(filter.tag)) return false;
        if (filter.subjectId && f.subject.id !== filter.subjectId && !f.subject.id.startsWith(filter.subjectId)) return false;
        if (q && !`${f.name} ${f.notes ?? ''} ${f.judge ?? ''} ${f.subject.title}`.toLowerCase().includes(q)) return false;
        return true;
      });
    },
    async get(ref) {
      const rows = all();
      const exact = rows.find((f) => f.id === ref);
      if (exact) return exact;
      const matches = rows.filter((f) => f.id.startsWith(ref));
      if (matches.length > 1) throw new Error(`${matches.length} freezes match ${ref}`);
      return matches[0] ?? null;
    },
    async update(id, patch) {
      const f = all().find((x) => x.id === id);
      if (!f) throw new Error(`no freeze ${id}`);
      const next = { ...f, ...patch, id: f.id, createdAt: f.createdAt };
      write(next);
      return next;
    },
    async remove(id) {
      if (!existsSync(path(id))) return false;
      unlinkSync(path(id));
      return true;
    },
  };
}
