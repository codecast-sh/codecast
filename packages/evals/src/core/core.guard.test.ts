import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// core/ is the query half @platform/evals takes over (evals-converge.md
// section 2): pure, so it runs in a browser, the api child and a test alike.
// It may import only itself, the evals contract, @platform/evals' contract
// and analysis (whose own layers test holds them pure) and @platform/evals
// for types. This walks every import from core/ through the shared modules
// it reaches, so a pure module cannot borrow the disk, a product module or a
// host global through another, and proves itself on a planted file.

const CORE = import.meta.dir;
const SRC = dirname(CORE);
const SHARED = resolve(SRC, '..', '..', 'shared');

/** Bare specifiers core may import; @platform/evals for types only. */
const PACKAGES = new Set(['@codecast/shared/contracts/evalsApi', '@platform/evals/contract', '@platform/evals/analysis']);
const TYPE_ONLY = new Set(['@platform/evals']);
/** Host globals a pure module never reads. */
const HOST_GLOBALS = /\b(?:process|Bun|document|window|localStorage|require|__dirname)\s*[.(]/;

interface Import {
  spec: string;
  typeOnly: boolean;
}

/** Every module a source names: static imports and re-exports (type-only marked), dynamic import() and require(). */
function importsOf(src: string): Import[] {
  const out: Import[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    const named = m[3] ?? '';
    // `import { type A, type B }` names nothing at runtime either.
    const allTypes = /^\{[^}]*\}$/.test(named.trim()) && named.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((n) => n.startsWith('type'));
    out.push({ spec: m[4]!, typeOnly: !!m[2] || allTypes });
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ spec: m[1]!, typeOnly: false });
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** Strips comments and string bodies so a global named in prose or a message is not a read. */
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');

const asFile = (base: string): string | null => [`${base}.ts`, join(base, 'index.ts'), base].find((p) => existsSync(p) && p.endsWith('.ts')) ?? null;

/** What is wrong with one source at `path`, and the modules it reaches that must be walked too. */
function problemsOf(path: string, src: string): { problems: string[]; next: string[] } {
  const problems: string[] = [];
  const next: string[] = [];
  const at = relative(SRC, path);
  const inShared = path.startsWith(SHARED);
  if (HOST_GLOBALS.test(code(src))) problems.push(`${at}: reads a host global (${HOST_GLOBALS.exec(code(src))![0].replace(/\s*[.(]$/, '')})`);
  for (const { spec, typeOnly } of importsOf(src)) {
    if (spec.startsWith('.')) {
      const file = asFile(resolve(dirname(path), spec));
      const allowed = file && (file.startsWith(CORE) || (inShared && file.startsWith(SHARED)));
      if (!allowed) problems.push(`${at}: imports ${spec}, outside core's allowed modules`);
      else next.push(file!);
    } else if (PACKAGES.has(spec)) {
      if (spec.startsWith('@codecast/shared/')) {
        const file = asFile(join(SHARED, spec.slice('@codecast/shared/'.length)));
        if (file) next.push(file);
      }
    } else if (TYPE_ONLY.has(spec)) {
      if (!typeOnly) problems.push(`${at}: imports ${spec} at runtime; core takes its types only`);
    } else problems.push(`${at}: imports ${spec}, outside core's allowed modules`);
  }
  return { problems, next };
}

/** Every problem reachable from core/'s modules. */
function walk(): string[] {
  const seen = new Set<string>();
  const queue = readdirSync(CORE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(CORE, f));
  const problems: string[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const r = problemsOf(path, readFileSync(path, 'utf8'));
    problems.push(...r.problems);
    queue.push(...r.next);
  }
  return problems;
}

describe('core/ stays pure', () => {
  test('every module core reaches imports only what core may', () => {
    expect(walk()).toEqual([]);
  });

  test('a planted impure module fails, naming each problem', () => {
    const planted = [
      "import { readFileSync } from 'node:fs';",
      "import { repPassed } from '../adapters/replay';",
      "import type { RunSummary } from '@platform/evals';",
      "import { fsRunSource } from '@platform/evals';",
      "import { plural } from '@platform/cli-kit/text';",
      "import { batchSet } from '@platform/evals/analysis';",
      "export const home = () => process.env.HOME; // process in a comment is fine",
      "const lazy = () => import('../registry');",
    ].join('\n');
    const { problems } = problemsOf(join(CORE, 'planted.ts'), planted);
    expect(problems).toEqual([
      'core/planted.ts: reads a host global (process)',
      'core/planted.ts: imports node:fs, outside core\'s allowed modules',
      'core/planted.ts: imports ../adapters/replay, outside core\'s allowed modules',
      'core/planted.ts: imports @platform/evals at runtime; core takes its types only',
      'core/planted.ts: imports @platform/cli-kit/text, outside core\'s allowed modules',
      'core/planted.ts: imports ../registry, outside core\'s allowed modules',
    ]);
  });
});
