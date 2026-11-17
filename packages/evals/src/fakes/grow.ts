import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import ts from 'typescript';

import { runAgent } from '../adapters/dryRun';
import { DRY_RUN_SCRIPT, evalsHome, REPO_ROOT, writeJsonAtomic } from '../paths';
import { type Tree } from './cast/tree';
import { capturesDir, readCaptures, type Capture, type Roster } from './capture';
import { byVerb, heldOut, scoreSession, type CallScore, type Oracles } from './fidelity';
import { scanEdit, type Leak } from './leak';

// The fake grows the way it was first written: from the answers real calls
// got. A model is handed what the fake gets wrong on the train split (the
// sessions it may learn from) and a copy of verbs.ts to edit. The edit is
// code nobody vouches for, written from prod text that holds other people's
// messages, so it never runs in this process: it must declare and import what
// the original does and nothing more, it is scored and its tests run inside
// prompt-dry-run.ts --exec (no network, no home, writes only to its own run
// dir), and it must carry nothing it could only have learned from real data.
// It is kept only when it answers more train calls as prod did, answers no
// fewer held-out calls as prod did, and the fake's own tests still pass, and
// "kept" means written to the grow record for a person to apply: grow never
// writes the tracked verbs.ts. The held-out split is never shown to the
// model; the honest score is the one on calls captured after the edit
// (`./evals fakes fidelity --after <grow.json at>`).

const FAKES = import.meta.dir;
const CAST = join(FAKES, 'cast');
const VERBS_REL = 'packages/evals/src/fakes/cast/verbs.ts';
const MODULE_FILES = ['index.ts', 'tree.ts', 'world.ts', 'verbs.ts'];

export interface Split {
  n: number;
  core: number;
  exact: number;
}

export interface GrowResult {
  at: string;
  dir: string;
  model: string;
  before: { train: Split; test: Split };
  after: { train: Split; test: Split } | null;
  accepted: boolean;
  why: string;
  costUsd: number;
  /** Accepted: the edit, for a person to read and copy over the tracked verbs.ts. */
  patch?: string;
  leaks?: Leak[];
}

const growHome = (): string => join(evalsHome(), 'fakes', 'grow');

/** Every call to a modelled verb across the given sessions, scored with a fake's `answer`. */
/** `from`: only calls made since then. Older ones answer as an older CLI did, and a fake grown toward them grows backwards. */
function score(sessions: Capture[][], tree: Tree, roster: Roster, oracles: Oracles, from: string): { split: Split; calls: CallScore[] } {
  const calls = sessions.flatMap((s) => scoreSession(s, tree, roster, oracles)).filter((c) => (c.at ?? '') >= from);
  const sum = byVerb(calls).reduce((a, v) => ({ n: a.n + v.n, core: a.core + v.core, exact: a.exact + v.exact }), { n: 0, core: 0, exact: 0 });
  return { split: sum, calls };
}

const rate = (s: Split): number => (s.n ? s.core / s.n : 0);
const fmt = (s: Split): string => `${s.core}/${s.n} core (${Math.round(100 * rate(s))}%), ${s.exact} exact`;

/** The train misses a model reads: the real answer beside the fake's, a few per verb, longest-standing shapes first. */
function missesFor(calls: CallScore[], limit: number): Array<Pick<CallScore, 'verb' | 'argv' | 'real' | 'fake' | 'answered'>> {
  const perVerb = new Map<string, number>();
  const out: Array<Pick<CallScore, 'verb' | 'argv' | 'real' | 'fake' | 'answered'>> = [];
  for (const c of calls.filter((c) => !c.core)) {
    const n = perVerb.get(c.verb) ?? 0;
    if (n >= Math.max(3, Math.ceil(limit / 6)) || out.length >= limit) continue;
    perVerb.set(c.verb, n + 1);
    out.push({ verb: c.verb, argv: c.argv.map((a) => (a.length > 400 ? `${a.slice(0, 400)}…` : a)), real: c.real.slice(0, 1500), fake: c.answered ? c.fake.slice(0, 1500) : '(declined: the fake left this call to the guard)', answered: c.answered });
  }
  return out;
}

const BRIEF = (n: number) => `# Grow the fake cast

The files here are a fake of the codecast CLI (\`cast\`) that eval replays run against: \`verbs.ts\` holds one handler per write verb, answering each call the way production answers it and keeping a world between calls. \`index.ts\`, \`tree.ts\` and \`world.ts\` are context (read them; do not edit them).

\`misses.json\` holds ${n} real calls the fake answers differently from production: each with its argv, what production printed (\`real\`) and what the fake printed (\`fake\`). Ids are compared by shape (a task the fake mints is ct-96001 where production minted another), and ${'`'}, arrives now${'`'} style receipt timing, the teammate tag, a pin's age and a decision's ladder are context the fake cannot know, so differences only there are not misses.

Edit \`verbs.ts\` so the fake answers more of these as production did, in a way that generalizes:
- Change behavior from the shape of the answers, never from one call's text: no session ids, task ids, handles, names, titles or messages copied from misses.json into the code. An edit that carries any is thrown away.
- Where production's answer depends on something the world does not hold (a server's state, another session), leave the handler's answer as it is, or return null so the call is refused as before. A wrong answer is worse than none.
- Keep the file's style: plain handlers, prod's wording, no comments that narrate the edit. Keep its imports exactly as they are, add nothing at the top level but declarations (functions, types, constants of literal values), use no global the file does not already use (plain data ones such as Array, Math, JSON aside), and look a key up in a map with \`own(map, key)\`, never a new \`map[key]\`. An edit that breaks any of these is thrown away unscored.
- Work in this directory only. When done, end your turn with one paragraph saying what you changed and why.
`;

/** What a module imports: each specifier with the names it binds, in a stable order. */
function importsOf(src: ts.SourceFile): string[] {
  return src.statements
    .filter(ts.isImportDeclaration)
    .map((d) => `${(d.moduleSpecifier as ts.StringLiteral).text} ${d.getText(src).replace(/\s+/g, ' ')}`)
    .sort();
}

/** An initializer that runs nothing when the module loads: a function, a literal, or a container of them. */
function inert(e: ts.Expression): boolean {
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isRegularExpressionLiteral(e) || ts.isIdentifier(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(e)) return ts.isNumericLiteral(e.operand);
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return inert(e.expression);
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => inert(s.expression));
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => inert(ts.isSpreadElement(x) ? x.expression : x));
  if (ts.isObjectLiteralExpression(e))
    return e.properties.every((p) => (ts.isPropertyAssignment(p) ? !ts.isComputedPropertyName(p.name) && inert(p.initializer) : ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)));
  // A Set or Map of literals: the one constructor call the file has always used for a lookup table.
  if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && ['Set', 'Map'].includes(e.expression.text) && (e.arguments ?? []).every(inert);
  return false;
}

/** Names that reach the machine (a process, a file, the network, new code), refused wherever they appear. */
const CAPABILITIES = new Set(['process', 'Bun', 'fetch', 'globalThis', 'global', 'eval', 'Function', 'Deno', 'WebAssembly', 'require', 'module', 'exports', 'Reflect', 'Proxy', 'self', 'window', '__dirname', '__filename', 'Worker', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'navigator', 'Atomics', 'SharedArrayBuffer', 'importScripts']);
/** Members that walk from any value to Function, and so to all of the above. */
const ESCAPES = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'caller', 'callee']);
const GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));
/** Globals that only compute on values (no clock but Date's, no I/O, no route to Function but the members above): any candidate may read them and take any member. */
const DATA = new Set(['Array', 'Math', 'JSON', 'Number', 'String', 'Boolean', 'Date', 'RegExp', 'Set', 'Map', 'WeakMap', 'WeakSet', 'undefined', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI']);

const keyOf = (n: ts.PropertyName | ts.Identifier): string | null => (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null);
const erased = (n: ts.Node): boolean => {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isImportDeclaration(p)) return true;
  return false;
};

/**
 * What a module can reach: the free names it reads (globals and imports),
 * each member it takes of a global, and each lookup by a computed key. Or why
 * it may reach anything at all: a capability by name, a walk to Function, a
 * dynamic import. `shadows`: its bindings that share a global's name, which
 * hide a read of that global from the free names.
 */
function reach(src: ts.SourceFile): { free: Set<string>; members: Set<string>; computed: string[]; shadows: Set<string> } | { refused: string } {
  const used = new Set<string>();
  const declared = new Set<string>();
  const members = new Set<string>();
  const computed: string[] = [];
  const shadows = new Set<string>();
  let refused: string | null = null;
  const at = (n: ts.Node) => `line ${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.getText(src).split('\n')[0]!.slice(0, 120)}`;
  const refuse = (why: string, n: ts.Node) => void (refused ??= `${why} (${at(n)})`);
  const visit = (n: ts.Node): void => {
    if (refused) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return refuse('a dynamic import', n);
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) return refuse('import.meta', n);
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ESCAPES.has(n.text) && !erased(n)) return refuse(`the key '${n.text}'`, n);
    if (ts.isElementAccessExpression(n) && !erased(n)) {
      const k = n.argumentExpression;
      if (!(ts.isStringLiteral(k) || ts.isNumericLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k))) computed.push(n.getText(src).replace(/\s+/g, ''));
    }
    if (ts.isIdentifier(n) && !erased(n)) {
      const p = n.parent;
      const name = n.text;
      if (ts.isPropertyAccessExpression(p) && p.name === n) {
        if (ESCAPES.has(name)) return refuse(`the member .${name}`, n);
        if (ts.isIdentifier(p.expression)) members.add(`${p.expression.text}.${name}`);
      } else if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isPropertyDeclaration(p)) && p.name === n) {
        if (ESCAPES.has(name)) return refuse(`the key ${name}`, n);
      } else if (ts.isBindingElement(p) && p.propertyName === n) {
        if (ESCAPES.has(name)) return refuse(`the member ${name}`, n);
      } else if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) {
        // a label names nothing
      } else if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isBindingElement(p) || ts.isEnumDeclaration(p)) && p.name === n) {
        if (CAPABILITIES.has(name)) return refuse(`a binding that shadows the global ${name}`, n);
        if (GLOBALS.has(name)) shadows.add(name);
        declared.add(name);
      } else {
        if (CAPABILITIES.has(name)) return refuse(`the global ${name}`, n);
        used.add(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const s of src.statements) {
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.name) declared.add(c.name.text);
      const b = c?.namedBindings;
      if (b && ts.isNamespaceImport(b)) declared.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const e of b.elements) declared.add(e.name.text);
    } else visit(s);
  }
  if (refused) return { refused };
  return { free: new Set([...used].filter((u) => !declared.has(u))), members: new Set([...members].filter((m) => !declared.has(m.split('.')[0]!))), computed, shadows };
}

/**
 * Why a candidate verbs.ts may not even be scored, or null. It reaches
 * nothing the original does not: the same imports, the same free names (the
 * data-only globals aside: none of the capabilities above, under any spelling), the
 * same members of each global, no lookup by a computed key the original lacks
 * (a key computed at run time can spell 'constructor'; a new one goes through
 * own()), and a top level of declarations whose loading runs nothing. Applied
 * by a person, it then runs in the harness as the original does, with the
 * same reach.
 */
export function staticCheck(original: string, candidate: string): string | null {
  const a = ts.createSourceFile('verbs.ts', original, ts.ScriptTarget.Latest, true);
  const b = ts.createSourceFile('verbs.ts', candidate, ts.ScriptTarget.Latest, true);
  const syntax = (b as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntax.length) return `it does not parse: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, ' ')}`;
  const [was, now] = [importsOf(a), importsOf(b)];
  if (was.join('\n') !== now.join('\n')) return `its imports differ from the original's: ${now.filter((i) => !was.includes(i)).join('; ') || 'one was dropped'}`;
  const [r0, r1] = [reach(a), reach(b)];
  if ('refused' in r1) return `it reaches past the fake: ${r1.refused}`;
  if ('refused' in r0) return `the original itself fails the check: ${r0.refused}`;
  // A shadowed global hides a read of it from the free names, so only the original's own shadows may stand.
  const newShadows = [...r1.shadows].filter((n) => !r0.shadows.has(n));
  if (newShadows.length) return `it binds a name that shadows a global: ${newShadows.join(', ')}`;
  const newFree = [...r1.free].filter((f) => !r0.free.has(f) && !DATA.has(f));
  if (newFree.length) return `it reads names the original does not: ${newFree.join(', ')}`;
  const newMembers = [...r1.members].filter((m) => !r0.members.has(m) && !DATA.has(m.split('.')[0]!));
  if (newMembers.length) return `it takes members of a global the original does not: ${newMembers.join(', ')}`;
  const left = [...r0.computed];
  for (const c of r1.computed) {
    const i = left.indexOf(c);
    if (i < 0) return `it looks up by a computed key the original does not (use own(map, key)): ${c}`;
    left.splice(i, 1);
  }
  for (const s of b.statements) {
    if (ts.isImportDeclaration(s) || ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier) continue;
    if (ts.isVariableStatement(s) && s.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && (!d.initializer || inert(d.initializer)))) continue;
    return `its top level runs code when it loads: ${s.getText(b).split('\n')[0]!.slice(0, 160)}`;
  }
  return null;
}

/**
 * A scratch copy of this package, the candidate in cast/, the rest of the
 * repository linked read-only: what the sandbox scores and tests, so the
 * candidate never sits in the checkout.
 */
/** What the copy links from the checkout rather than copies. */
const LINKED = ['packages/evals/node_modules', 'packages/evals/fixtures', 'packages/cli', 'packages/shared', 'node_modules', 'platform', 'package.json', 'tsconfig.json'].filter((l) => existsSync(join(REPO_ROOT, l)));

function scratchCopy(root: string, verbs: string): string {
  const evals = join(root, 'packages', 'evals');
  mkdirSync(evals, { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) copyFileSync(join(REPO_ROOT, 'packages', 'evals', f), join(evals, f));
  cpSync(join(REPO_ROOT, 'packages', 'evals', 'src'), join(evals, 'src'), { recursive: true });
  for (const l of LINKED) symlinkSync(join(REPO_ROOT, l), join(root, l));
  writeFileSync(join(evals, 'src', 'fakes', 'cast', 'verbs.ts'), verbs);
  return root;
}

/** One command in the closed world, in the scratch copy; its exit code and output. */
function sandboxed(run: string, copy: string, reads: string[], command: string[]): { code: number; out: string; err: string } {
  // The copy, the checkout, and wherever a linked tree really lives (an install can be a link out of the checkout).
  const readable = [...new Set([copy, REPO_ROOT, ...LINKED.map((l) => realpathSync(join(REPO_ROOT, l))), ...reads])];
  const p = Bun.spawnSync(['bun', DRY_RUN_SCRIPT, '--exec', '--run', run, '--cwd', join(copy, 'packages', 'evals'), ...readable.flatMap((r) => ['--read', r]), '--', ...command], { stdout: 'pipe', stderr: 'pipe' });
  const read = (f: string) => (existsSync(join(run, f)) ? readFileSync(join(run, f), 'utf8') : '');
  return { code: p.exitCode ?? 1, out: read('exec.out'), err: read('exec.err') || p.stderr.toString() };
}

/** A failure's error lines before bun's code frame, which only quotes the candidate back. */
const errorLines = (err: string): string => {
  const lines = err.split('\n').filter((l) => l.trim());
  const errors = lines.filter((l) => /^\s*(\w*Error|error)\b|EPERM|EACCES/.test(l));
  return (errors.length ? errors : lines).slice(0, 6).join('\n');
};

export interface Judged {
  accepted: boolean;
  why: string;
  after: { train: Split; test: Split } | null;
  leaks?: Leak[];
}

/**
 * Whether a candidate verbs.ts is kept: loadable by the rules above, free of
 * real data, scored in the sandbox above the original on train and no lower
 * on held-out, with the fake's tests green on it. Writes nothing outside `dir`.
 * `check` stands in for staticCheck, so a test can show the walls behind it.
 */
export function judge(o: { dir: string; original: string; candidate: string; treeFile: string; roster: Roster; from: string; privateText: string; captures?: string; isPublic?: (t: string) => boolean; check?: typeof staticCheck }): Judged {
  const refused = (o.check ?? staticCheck)(o.original, o.candidate);
  if (refused) return { accepted: false, why: `the edited verbs.ts is not scored: ${refused}`, after: null };
  const names = Object.values(o.roster.people ?? {}).filter((n) => typeof n === 'string');
  const leaks = scanEdit(o.original, o.candidate, o.privateText, names, o.isPublic);
  if (leaks.length) return { accepted: false, why: `the edit carries real data: ${leaks.map((l) => l.token).join(', ')}`, after: null, leaks };

  const box = join(o.dir, 'score');
  rmSync(box, { recursive: true, force: true });
  const data = join(box, 'data');
  mkdirSync(data, { recursive: true });
  copyFileSync(o.treeFile, join(data, 'cli-tree.json'));
  writeFileSync(join(data, 'roster.json'), JSON.stringify(o.roster));
  const captures = o.captures ?? capturesDir();
  const scoreWith = (name: string, verbs: string) => {
    const copy = scratchCopy(join(box, `${name}-tree`), verbs);
    const run = join(box, `${name}-score`);
    const out = join(run, `score-${randomUUID()}.json`);
    const r = sandboxed(run, copy, [data, captures], ['bun', 'src/fakes/scoreSplits.ts', captures, join(data, 'cli-tree.json'), join(data, 'roster.json'), o.from, out]);
    if (r.code !== 0 || !existsSync(out)) return { error: errorLines(r.err) || `exit ${r.code}, no score written`, copy };
    return { split: JSON.parse(readFileSync(out, 'utf8')) as { train: Split; test: Split }, copy };
  };
  const was = scoreWith('original', o.original);
  if (!('split' in was) || !was.split) return { accepted: false, why: `the sandbox cannot score the original: ${was.error}`, after: null };
  const now = scoreWith('candidate', o.candidate);
  if (!('split' in now) || !now.split) return { accepted: false, why: `the edited verbs.ts fails in the sandbox:\n${now.error}`, after: null };
  const [before, after] = [was.split, now.split];
  if (rate(after.train) <= rate(before.train)) return { accepted: false, why: `train did not rise: ${fmt(before.train)} → ${fmt(after.train)}`, after };
  if (rate(after.test) < rate(before.test)) return { accepted: false, why: `held-out dropped: ${fmt(before.test)} → ${fmt(after.test)}`, after };
  // The tests pass only as the original's do: bun's own summary, every test the original ran passing, besides the exit code a candidate could force.
  const tests = (name: string, copy: string) => {
    const t = sandboxed(join(box, `${name}-test`), copy, [], ['bun', 'test', 'src/fakes/fakes.test.ts']);
    const n = (re: RegExp) => Number(t.err.match(re)?.[1] ?? NaN);
    return { code: t.code, pass: n(/^\s*(\d+) pass$/m), fail: n(/^\s*(\d+) fail$/m), ran: n(/^Ran (\d+) tests? across/m), err: t.err };
  };
  const want = tests('original', was.copy);
  if (want.code !== 0 || want.fail !== 0 || !(want.pass > 0) || want.pass !== want.ran) return { accepted: false, why: `the fake's tests do not pass in the sandbox even on the original:\n${errorLines(want.err)}`, after };
  const got = tests('candidate', now.copy);
  if (got.code !== 0 || got.fail !== 0 || got.pass !== want.pass || got.ran !== want.ran)
    return { accepted: false, why: `the fake's tests fail with it (${got.pass} of ${want.pass} pass, ${got.fail} fail, exit ${got.code}):\n${got.err.split('\n').filter((l) => /\(fail\)|error:/.test(l)).slice(0, 8).join('\n')}`, after };
  return { accepted: true, why: `train ${fmt(before.train)} → ${fmt(after.train)}; held-out ${fmt(before.test)} → ${fmt(after.test)}`, after };
}

/**
 * One grow round: the train misses to a model in the closed world, its
 * verbs.ts judged in the sandbox, and a kept edit written to the grow record
 * (verbs.after.ts, verbs.patch) for a person to apply. `dry` stops before the
 * model, to check the scores and the brief. `edit` stands in for the model.
 */
export async function grow(o: { tree: Tree; treeFile: string; roster: Roster; model: string; misses: number; isRead: (argv: string[]) => boolean; sinceDays: number; dry?: boolean; edit?: (work: string) => Promise<{ costUsd: number }> }): Promise<GrowResult> {
  const from = new Date(Date.now() - o.sinceDays * 86_400_000).toISOString();
  const all = readCaptures().filter((s) => s.length);
  const train = all.filter((s) => !heldOut(s[0]!.session));
  const test = all.filter((s) => heldOut(s[0]!.session));
  const at = new Date().toISOString();
  const dir = join(growHome(), at.replace(/[:.]/g, '-'));
  const agentDir = join(dir, 'agent');
  // Inside the run dir runAgent gives the harness (agentDir/agent): the one place the model's sandbox may write.
  const work = join(agentDir, 'agent', 'work');
  mkdirSync(work, { recursive: true });
  const base = { train: score(train, o.tree, o.roster, { isRead: o.isRead }, from), test: score(test, o.tree, o.roster, { isRead: o.isRead }, from) };
  const before = { train: base.train.split, test: base.test.split };
  const misses = missesFor(base.train.calls, o.misses);
  for (const f of MODULE_FILES) copyFileSync(join(CAST, f), join(work, f));
  writeFileSync(join(work, 'misses.json'), JSON.stringify(misses, null, 1));
  const result = (r: Partial<GrowResult> & Pick<GrowResult, 'accepted' | 'why'>): GrowResult => {
    const full: GrowResult = { at, dir, model: o.model, before, after: null, costUsd: 0, ...r };
    writeJsonAtomic(join(dir, 'grow.json'), full);
    return full;
  };
  if (!misses.length) return result({ accepted: false, why: 'the fake answers every train call as prod did' });
  if (o.dry) return result({ accepted: false, why: `dry: ${misses.length} train misses written to ${work}; no model ran` });

  const a = o.edit ? await o.edit(work) : await runAgent({ prompt: BRIEF(misses.length), model: o.model, cwd: work, maxTurns: 60, tools: ['Bash', 'Read', 'Write', 'Edit'] }, agentDir, { dry: false });
  const edited = join(work, 'verbs.ts');
  const original = readFileSync(join(CAST, 'verbs.ts'), 'utf8');
  const candidate = existsSync(edited) ? readFileSync(edited, 'utf8') : original;
  if (candidate === original) return result({ accepted: false, why: 'the model left verbs.ts as it was', costUsd: a.costUsd });
  writeFileSync(join(dir, 'verbs.before.ts'), original);
  writeFileSync(join(dir, 'verbs.candidate.ts'), candidate);
  const privateText = `${readFileSync(join(work, 'misses.json'), 'utf8')}\n${JSON.stringify(train)}`;
  const j = judge({ dir, original, candidate, treeFile: o.treeFile, roster: o.roster, from, privateText });
  if (!j.accepted) return result({ accepted: false, why: j.why, after: j.after, leaks: j.leaks, costUsd: a.costUsd });
  writeFileSync(join(dir, 'verbs.after.ts'), candidate);
  const d = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', `--src-prefix=a/${VERBS_REL.replace(/verbs\.ts$/, '')}`, `--dst-prefix=b/${VERBS_REL.replace(/verbs\.ts$/, '')}`, 'verbs.before.ts', 'verbs.after.ts'], { cwd: dir, stdout: 'pipe' });
  const patch = d.stdout.toString().replace(/verbs\.(before|after)\.ts/g, 'verbs.ts');
  writeFileSync(join(dir, 'verbs.patch'), patch);
  return result({ accepted: true, why: j.why, after: j.after, patch: join(dir, 'verbs.patch'), costUsd: a.costUsd });
}
