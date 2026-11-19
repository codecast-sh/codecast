// What React Compiler does with a set of files, and what it would get wrong.
//
//   bun scripts/react-compiler-report.ts                      # the allowlist (plugins/reactCompiler.ts)
//   bun scripts/react-compiler-report.ts components/inbox/    # a candidate, before it joins the list
//   bun scripts/react-compiler-report.ts --json <entries…>    # the same as data
//   bun scripts/react-compiler-report.ts --compiled <entries…> # also name every compiled function
//
// Two reports, both over real compiler runs with the build's options:
//
// 1. Outcome. Every component and hook the compiler compiled, and every one
//    it left as written, with the compiler's own reason and the line.
//
// 2. Reads the compiler cannot see. It caches what a compiled function
//    computes from the same inputs, which is only right when render reads
//    nothing but props, state, context and hook results. This walks each
//    COMPILED function's render path (its body, plus callbacks that run
//    during render: useMemo, a state initializer, an array method, an IIFE)
//    and names every read of something else:
//      store    `X.getState()` or the `store` proxy
//      storage  localStorage / sessionStorage
//      clock    Date.now(), new Date(), performance.now()
//      dom      a document / window call
//      module   a module-level `let` or Map/Set that some function writes
//    directly, or inside a helper it calls (followed through imports, any
//    depth). A helper call is the dangerous form: `timeAgo(ts)` compiles to
//    "recompute when ts changes", so the label stops moving. Each line needs a
//    decision before the file ships compiled: pass the value in from a hook,
//    or put `"use no memo"` in the function with the reason. The script exits
//    1 while any read is neither.
//
// A read can also hide behind a function a hook hands back:
// `const relativeTime = useRelativeTime()` where the callback reads Date.now()
// when called. The compiler caches `relativeTime(ts)` on the callback and
// `ts`, and a callback that never changes freezes the label. So each hook's
// returned functions are read too (returned directly, through useCallback or
// useMemo, as a property of a returned object or an item of a returned array,
// or handed on from another hook), and a call to one on a compiled render path
// is listed like a helper call. A hook-returned function that cannot be read
// (a context value, a hook outside the tree) is listed for a look by hand and
// fails the run. Not followed: a function received as a prop (those calls are
// listed, for the same look), and one passed on as a prop or an argument.
//
// A direct `useInboxStore.getState()` in render is counted separately: the
// compiler refuses such a component ("Hooks may not be referenced as normal
// values"), so it stays uncompiled and correct.
import { parseSync, transformSync, traverse, types as t, type NodePath } from "@babel/core";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REACT_COMPILER_OPTIONS, REACT_COMPILER_PLUGIN, inReactCompilerSources, reactCompilerSources } from "../plugins/reactCompiler";
import { ARRAY_METHODS, isStateInitializer, STORAGE, runsDuringRender, maybeArgs, mutableModuleBindings } from "./reactCompilerAst";

const WEB = path.resolve(import.meta.dir, "..");
const SHARED = path.resolve(WEB, "..", "shared");
const REPO = path.resolve(WEB, "..", "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const entries = args.filter((a) => !a.startsWith("--"));
const sources = entries.length ? entries : [...reactCompilerSources()];

type Kind = "store" | "storage" | "clock" | "dom" | "module";
// `param`: the read sits in the default value of that parameter (`now = Date.now()`),
// so it happens only when a caller leaves the argument out.
type Read = { kind: Kind; what: string; line: number; once?: boolean; param?: number };
// `maybe`: positions of arguments that are passed but may be undefined (a
// prop, an optional field), where the callee's default value would still run.
type Call = { local: string; member?: string; args: number; maybe: number[] };
type Fn = { name: string; line: number; reads: Read[]; calls: Call[]; optedOut: boolean; returns?: Returned };
// What a hook hands back that a caller can call: itself a function, an object
// or array holding functions, or whatever another hook (`from`) hands back.
type Returned = { self?: Fn; props: Map<string, Fn>; items: Map<number, Fn>; from: Call[] };
type FileInfo = {
  file: string;
  fns: Map<string, Fn>;
  imports: Map<string, { from: string; name: string }>; // local name -> source file + exported name ("*" = namespace)
  reexports: Map<string, { from: string; name: string }>;
  stars: string[];
};

// --- Reading files ----------------------------------------------------------

const parse = (file: string, code: string) =>
  parseSync(code, { filename: file, babelrc: false, configFile: false, sourceType: "module", parserOpts: { plugins: file.endsWith(".ts") ? ["typescript"] : ["typescript", "jsx"] } });

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(WEB, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else if (spec === "@codecast/shared") base = path.join(SHARED, "index");
  else if (spec.startsWith("@codecast/shared/")) base = path.join(SHARED, spec.slice("@codecast/shared/".length));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The reads and calls on a function's render path. `deferred` false means the
 * whole body counts (a helper: whatever it does, it does when called).
 */
function scan(fnPath: NodePath<t.Function>, info: { file: string; storeProxy: Set<string>; mutable: Set<string> }, renderOnly: boolean): { reads: Read[]; calls: Fn["calls"]; hookGetState: number } {
  const reads: Read[] = [];
  const calls: Fn["calls"] = [];
  let hookGetState = 0;
  let once = false;
  const onRenderPath = (p: NodePath): boolean => {
    once = false;
    current = p;
    if (!renderOnly) return true;
    let fn = p.getFunctionParent();
    while (fn && fn.node !== fnPath.node) {
      if (!runsDuringRender(fn)) return false;
      if (isStateInitializer(fn)) once = true;
      fn = fn.getFunctionParent();
    }
    return true;
  };
  const line = (p: NodePath) => p.node.loc?.start.line ?? 0;
  let current: NodePath | null = null;
  const paramOf = (p: NodePath): number | undefined => {
    const holder = p.findParent((up) => up.parentPath?.node === fnPath.node && up.listKey === "params");
    return holder && holder.isAssignmentPattern() ? (holder.key as number) : undefined;
  };
  const push = (read: Read) => {
    const param = current ? paramOf(current) : undefined;
    reads.push({ ...read, ...(once ? { once: true } : {}), ...(param !== undefined ? { param } : {}) });
  };
  const isGlobal = (p: NodePath, name: string) => !p.scope.getBinding(name);
  fnPath.traverse({
    CallExpression(p) {
      if (!onRenderPath(p)) return;
      const callee = p.node.callee;
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
        const prop = callee.property.name;
        const obj = callee.object;
        if (prop === "getState" && p.node.arguments.length === 0) {
          push({ kind: "store", what: `${t.isIdentifier(obj) ? obj.name : "…"}.getState()`, line: line(p) });
          if (t.isIdentifier(obj) && /^use[A-Z]/.test(obj.name)) hookGetState++;
          return;
        }
        if (t.isIdentifier(obj)) {
          if (obj.name === "Date" && prop === "now" && isGlobal(p, "Date")) push({ kind: "clock", what: "Date.now()", line: line(p) });
          else if (obj.name === "performance" && prop === "now" && isGlobal(p, "performance")) push({ kind: "clock", what: "performance.now()", line: line(p) });
          else if (obj.name === "document" && isGlobal(p, "document")) push({ kind: "dom", what: `document.${prop}()`, line: line(p) });
          else if (obj.name === "window" && isGlobal(p, "window") && /^(matchMedia|getComputedStyle|getSelection)$/.test(prop)) push({ kind: "dom", what: `window.${prop}()`, line: line(p) });
          else if (!once) calls.push({ local: obj.name, member: prop, args: p.node.arguments.length, maybe: maybeArgs(p) });
        }
        return;
      }
      if (t.isIdentifier(callee)) {
        if (/^use[A-Z]/.test(callee.name)) return; // a hook's result is never cached by the caller
        if (callee.name === "matchMedia" && isGlobal(p, "matchMedia")) push({ kind: "dom", what: "matchMedia()", line: line(p) });
        else if (!once) calls.push({ local: callee.name, args: p.node.arguments.length, maybe: maybeArgs(p) });
      }
    },
    NewExpression(p) {
      if (!onRenderPath(p)) return;
      if (t.isIdentifier(p.node.callee, { name: "Date" }) && p.node.arguments.length === 0 && isGlobal(p, "Date")) push({ kind: "clock", what: "new Date()", line: line(p) });
    },
    Identifier(p) {
      if (!p.isReferencedIdentifier() || !onRenderPath(p)) return;
      const name = p.node.name;
      if (STORAGE.has(name) && isGlobal(p, name)) push({ kind: "storage", what: name, line: line(p) });
      else if (info.storeProxy.has(name) && p.scope.getBinding(name)?.scope.path.isProgram()) push({ kind: "store", what: `${name} proxy`, line: line(p) });
      else if (info.mutable.has(name) && p.scope.getBinding(name)?.scope.path.isProgram()) {
        // A write is not a read; `cache.set(k, v)` after a miss is the cache's own business.
        const parent = p.parentPath;
        const isWrite = (parent?.isAssignmentExpression() && parent.node.left === p.node) || parent?.isUpdateExpression();
        if (!isWrite) push({ kind: "module", what: `${name} (${path.relative(REPO, info.file)})`, line: line(p) });
      }
    },
  });
  return { reads, calls, hookGetState };
}

const hasNoMemo = (fn: t.Function) => t.isBlockStatement(fn.body) && fn.body.directives.some((d) => d.value.value === "use no memo" || d.value.value === "use no forget");

const unwrap = (p: NodePath): NodePath => {
  while (p.isTSAsExpression() || p.isTSNonNullExpression() || p.isTSSatisfiesExpression() || p.isParenthesizedExpression()) p = p.get("expression") as NodePath;
  return p;
};
const calleeName = (call: t.CallExpression): string | null =>
  t.isIdentifier(call.callee) ? call.callee.name : t.isMemberExpression(call.callee) && t.isIdentifier(call.callee.property) ? call.callee.property.name : null;
const isHookName = (name: string | null): name is string => !!name && /^use[A-Z]/.test(name);
const asCall = (p: NodePath<t.CallExpression>): Call | null => {
  const callee = p.node.callee;
  if (t.isIdentifier(callee)) return { local: callee.name, args: p.node.arguments.length, maybe: maybeArgs(p) };
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) return { local: callee.object.name, member: callee.property.name, args: p.node.arguments.length, maybe: maybeArgs(p) };
  return null;
};

/** The expressions a function can return: each `return` of its own body, or an arrow's expression body. */
function returnedOf(fn: NodePath<t.Function>): NodePath[] {
  const body = fn.get("body") as NodePath;
  if (!body.isBlockStatement()) return [body];
  const out: NodePath[] = [];
  fn.traverse({
    Function(inner) { inner.skip(); },
    ReturnStatement(ret) { const arg = ret.get("argument"); if (arg.node) out.push(arg as NodePath); },
  });
  return out;
}

/**
 * What a hook hands back, as far as a caller could call it. `scanFn` reads a
 * function as it runs when called. Follows a local variable to its value,
 * useCallback and any `use*(fn, …)` wrapper to the function, and useMemo to
 * what its factory returns.
 */
function returnedShape(hook: NodePath<t.Function>, label: string, scanFn: (fn: NodePath<t.Function>, name: string) => Fn): Returned {
  const out: Returned = { props: new Map(), items: new Map(), from: [] };
  const seen = new Set<t.Node>();
  const callable = (p: NodePath, name: string): Fn | null => {
    p = unwrap(p);
    if (seen.has(p.node)) return null;
    if (p.isFunction()) return scanFn(p as NodePath<t.Function>, name);
    if (p.isIdentifier()) {
      const decl = p.scope.getBinding(p.node.name)?.path;
      if (decl?.isFunctionDeclaration()) return scanFn(decl, name);
      if (decl?.isVariableDeclarator() && t.isIdentifier(decl.node.id) && decl.node.init) { seen.add(p.node); return callable(decl.get("init") as NodePath, name); }
      return null;
    }
    if (p.isCallExpression() && isHookName(calleeName(p.node)) && calleeName(p.node) !== "useMemo") {
      const first = p.get("arguments")[0] as NodePath | undefined;
      return first ? callable(first, name) : null;
    }
    if (p.isCallExpression() && calleeName(p.node) === "useMemo") {
      const factory = unwrap(p.get("arguments")[0] as NodePath);
      if (factory?.isFunction()) for (const ret of returnedOf(factory as NodePath<t.Function>)) { const fn = callable(ret, name); if (fn) return fn; }
    }
    return null;
  };
  const shape = (p: NodePath, depth = 0) => {
    p = unwrap(p);
    if (depth > 4) return;
    if (p.isObjectExpression()) {
      for (const prop of p.get("properties")) {
        if (prop.isObjectMethod() && t.isIdentifier(prop.node.key)) out.props.set(prop.node.key.name, scanFn(prop as unknown as NodePath<t.Function>, `${label}.${prop.node.key.name}`));
        else if (prop.isObjectProperty() && t.isIdentifier(prop.node.key)) { const fn = callable(prop.get("value") as NodePath, `${label}.${prop.node.key.name}`); if (fn) out.props.set(prop.node.key.name, fn); }
      }
      return;
    }
    if (p.isArrayExpression()) {
      p.get("elements").forEach((el, i) => { if (el.node) { const fn = callable(el as NodePath, `${label}[${i}]`); if (fn) out.items.set(i, fn); } });
      return;
    }
    if (p.isIdentifier()) {
      const decl = p.scope.getBinding(p.node.name)?.path;
      if (decl?.isVariableDeclarator() && t.isIdentifier(decl.node.id) && decl.node.init) { const init = unwrap(decl.get("init") as NodePath); if (!init.isFunction()) { shape(init, depth + 1); if (out.self || out.props.size || out.items.size || out.from.length) return; } }
    }
    if (p.isCallExpression() && calleeName(p.node) === "useMemo") {
      const factory = unwrap(p.get("arguments")[0] as NodePath);
      if (factory?.isFunction()) for (const ret of returnedOf(factory as NodePath<t.Function>)) shape(ret, depth + 1);
      if (out.self || out.props.size || out.items.size) return;
    }
    const fn = callable(p, label);
    if (fn) { out.self ??= fn; return; }
    // `return useOther(args)`: whatever that hook hands back.
    if (p.isCallExpression() && isHookName(calleeName(p.node))) { const call = asCall(p); if (call) out.from.push(call); }
  };
  for (const ret of returnedOf(hook)) shape(ret);
  return out;
}

const files = new Map<string, FileInfo | null>();
const asts = new Map<string, ReturnType<typeof parse>>();

function load(file: string): FileInfo | null {
  if (files.has(file)) return files.get(file)!;
  files.set(file, null);
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(file, readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!ast) return null;
  asts.set(file, ast);
  const info: FileInfo = { file, fns: new Map(), imports: new Map(), reexports: new Map(), stars: [] };
  const storeProxy = new Set<string>();
  let mutable = new Set<string>();
  const add = (name: string, fnPath: NodePath<t.Function>) => {
    // The helper's own run: a closure it only returns (an action's `run`)
    // reads nothing while the caller renders.
    const { reads, calls } = scan(fnPath, { file, storeProxy, mutable }, true);
    const fn: Fn = { name, line: fnPath.node.loc?.start.line ?? 0, reads, calls, optedOut: hasNoMemo(fnPath.node) };
    // A hook: also what the functions it hands back read when a caller calls them.
    if (isHookName(name)) {
      fn.returns = returnedShape(fnPath, `${name}()`, (inner, label) => {
        const own = scan(inner, { file, storeProxy, mutable }, true);
        return { name: label, line: inner.node.loc?.start.line ?? 0, reads: own.reads, calls: own.calls, optedOut: false };
      });
    }
    info.fns.set(name, fn);
  };
  traverse(ast, {
    Program(p) {
      mutable = mutableModuleBindings(p);
      for (const stmt of p.get("body")) {
        if (stmt.isImportDeclaration() && stmt.node.importKind !== "type") {
          const from = resolveImport(file, stmt.node.source.value);
          if (!from) continue;
          for (const spec of stmt.node.specifiers) {
            if (t.isImportSpecifier(spec)) {
              const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
              info.imports.set(spec.local.name, { from, name: imported });
              if (imported === "store" && /store\/inboxStore\.ts$/.test(from)) storeProxy.add(spec.local.name);
            } else if (t.isImportDefaultSpecifier(spec)) info.imports.set(spec.local.name, { from, name: "default" });
            else info.imports.set(spec.local.name, { from, name: "*" });
          }
        } else if (stmt.isExportNamedDeclaration() && stmt.node.source) {
          const from = resolveImport(file, stmt.node.source.value);
          if (!from) continue;
          for (const spec of stmt.node.specifiers) {
            if (t.isExportSpecifier(spec)) info.reexports.set(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, { from, name: spec.local.name });
          }
        } else if (stmt.isExportAllDeclaration()) {
          const from = resolveImport(file, stmt.node.source.value);
          if (from) info.stars.push(from);
        }
      }
    },
    // Top-level named functions only: what another module, or a component in
    // this one, can call by name.
    FunctionDeclaration(p) {
      if (p.parentPath.isProgram() || p.parentPath.isExportNamedDeclaration() || p.parentPath.isExportDefaultDeclaration()) {
        if (p.node.id) add(p.node.id.name, p);
        if (p.parentPath.isExportDefaultDeclaration()) add("default", p);
      }
    },
    VariableDeclarator(p) {
      const decl = p.parentPath;
      if (!decl.parentPath?.isProgram() && !decl.parentPath?.isExportNamedDeclaration()) return;
      if (!t.isIdentifier(p.node.id)) return;
      let init = p.get("init") as NodePath;
      // memo(function X…), forwardRef((props, ref) => …), memo(forwardRef(…))
      while (init.isCallExpression() && init.node.arguments.length > 0) init = init.get("arguments")[0] as NodePath;
      if (init.isFunction()) add(p.node.id.name, init as NodePath<t.Function>);
    },
  });
  files.set(file, info);
  return info;
}

function lookup(file: string, name: string, seen = new Set<string>()): { info: FileInfo; fn: Fn } | null {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const info = load(file);
  if (!info) return null;
  const fn = info.fns.get(name);
  if (fn) return { info, fn };
  const re = info.reexports.get(name);
  if (re) return lookup(re.from, re.name, seen);
  const imp = info.imports.get(name);
  if (imp && imp.name !== "*") return lookup(imp.from, imp.name, seen);
  for (const star of info.stars) {
    const hit = lookup(star, name, seen);
    if (hit) return hit;
  }
  return null;
}

function resolveCall(info: FileInfo, call: Call): { info: FileInfo; fn: Fn } | null {
  if (call.member) {
    const imp = info.imports.get(call.local);
    return imp?.name === "*" ? lookup(imp.from, call.member) : null;
  }
  if (info.fns.has(call.local)) return { info, fn: info.fns.get(call.local)! };
  const imp = info.imports.get(call.local);
  return imp && imp.name !== "*" ? lookup(imp.from, imp.name) : null;
}

/** What the hook a call names hands back, following `return useOther()` a few steps. */
function returnsOf(info: FileInfo, call: Call, depth = 0): { info: FileInfo; returned: Returned } | null {
  const target = resolveCall(info, call);
  const returned = target?.fn.returns;
  if (!target || !returned) return null;
  if (returned.self || returned.props.size || returned.items.size || depth > 3) return { info: target.info, returned };
  for (const next of returned.from) {
    const hit = returnsOf(target.info, next, depth + 1);
    if (hit) return hit;
  }
  return { info: target.info, returned };
}

// What a helper reads, itself or through the helpers it calls: one shortest
// chain per kind. Hooks are not followed (a hook's caller never caches it).
const impurity = new Map<string, Map<Kind, string[]>>();
function reachOf(info: FileInfo, fn: Fn, call: Pick<Call, "args" | "maybe">, stack = new Set<string>()): Map<Kind, string[]> {
  const { args, maybe } = call;
  const key = `${info.file}\0${fn.name}\0${args}\0${maybe.join(",")}`;
  const known = impurity.get(key);
  if (known) return known;
  const out = new Map<Kind, string[]>();
  if (stack.has(key)) return out;
  stack.add(key);
  // A default-value read counts only when this call leaves that argument out.
  for (const read of fn.reads) {
    if (out.has(read.kind)) continue;
    if (read.param === undefined || read.param >= args) out.set(read.kind, [read.what]);
    else if (maybe.includes(read.param)) out.set(read.kind, [`${read.what} (when argument ${read.param + 1} is undefined)`]);
  }
  for (const call of fn.calls) {
    const target = resolveCall(info, call);
    if (!target || /^use[A-Z]/.test(target.fn.name)) continue;
    for (const [kind, chain] of reachOf(target.info, target.fn, call, stack)) {
      if (!out.has(kind)) out.set(kind, [target.fn.name, ...chain]);
    }
  }
  stack.delete(key);
  impurity.set(key, out);
  return out;
}

// Module-level caches read on a render path and reviewed as pure: the value
// depends only on the key it is read by (or is written once before any reader
// mounts), so a compiled caller that caches the result per key sees what an
// uncompiled one would. Keyed by the binding's
// name and file as the report prints them; each entry says why it is safe. A cache whose
// answer changes for the same key (a decode table, a "sent" map) never goes here.
const REVIEWED_PURE: Record<string, string> = {
  "STRIP_SYSTEM_TAGS_CACHE (packages/web/components/conversation/classify.ts)": "memo of a pure string transform, keyed by the input string",
  "MD_RENDER_CACHE (packages/web/components/conversation/markdown.tsx)": "memo of rendered markdown, keyed by the source text and its options",
  "formatters (packages/shared/time/index.ts)": "Intl formatters by locale and options, each built once",
  "cardPatterns (packages/shared/contracts/cloudAgents.ts)": "regular expressions built once per card kind",
  "tokensByConversation (packages/web/lib/shareTokenScope.ts)": "a conversation's share token is recorded before the conversation page's children mount (ConversationPageClient) and never changes for that id",
};
const reviewed = (_file: string, what: string) => !!REVIEWED_PURE[what];

// --- The files asked about ------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (inReactCompilerSources(full, sources)) out.push(full);
  }
  return out;
}
const targets = [...new Set(sources.flatMap((entry) => (entry.endsWith("/") ? walk(path.join(WEB, entry)) : inReactCompilerSources(path.join(WEB, entry), sources) ? [path.join(WEB, entry)] : [])))].sort();

type Skipped = { file: string; line: number; name: string; category: string; reason: string; at: number | null };
type Hazard = { file: string; line: number; fn: string; kind: Kind; what: string; via: string[] };
// A function a hook handed back, called on a compiled render path, that could
// not be read (a context value, a hook outside the tree, a shape not understood).
type Unread = { file: string; line: number; fn: string; call: string; hook: string };
const unread: Unread[] = [];
// How many such calls were read, so "none found" can be told from "none looked at".
let handedCallsRead = 0;
// A function received as a prop and called while rendering. What it reads is
// the caller's business and cannot be followed from here: listed, not failed.
const propCalls: Array<{ file: string; line: number; fn: string; call: string }> = [];
// Hooks whose results are handled elsewhere or are not functions that read anything.
const DATA_METHODS = new Set([...ARRAY_METHODS, "get", "has", "at", "slice", "includes", "indexOf", "join", "concat", "keys", "values", "entries", "split", "trim", "startsWith", "endsWith", "replace", "match", "toLowerCase", "toUpperCase", "toString", "toFixed", "padStart", "localeCompare", "flat", "toReversed", "with"]);
const KNOWN_RESULT = /^use(State|Reducer|Ref|Callback|Memo|Transition|Id|DeferredValue|ActionState|Optimistic)$/;
const compiled: Array<{ file: string; line: number; name: string; slots: number }> = [];
const skipped: Skipped[] = [];
const hazards: Hazard[] = [];
const optedOut: Array<{ file: string; line: number; name: string; why: string }> = [];
const renderGetState: Array<{ file: string; line: number; fn: string; compiled: boolean }> = [];
let transformMs = 0;

const rel = (file: string) => path.relative(WEB, file);

for (const file of targets) {
  const code = readFileSync(file, "utf8");
  const events: any[] = [];
  const t0 = performance.now();
  try {
    transformSync(code, {
      filename: file, babelrc: false, configFile: false, sourceType: "module", code: false,
      parserOpts: { plugins: file.endsWith(".ts") ? ["typescript"] : ["typescript", "jsx"] },
      plugins: [[REACT_COMPILER_PLUGIN, { ...REACT_COMPILER_OPTIONS, logger: { logEvent: (_: string | null, e: any) => events.push(e) } }]],
    });
  } catch (err) {
    skipped.push({ file: rel(file), line: 0, name: "(whole file)", category: "Crash", reason: String(err).split("\n")[0], at: null });
    continue;
  }
  transformMs += performance.now() - t0;

  const info = load(file);
  const ast = asts.get(file);
  if (!info || !ast) continue;

  // Name every function by where it starts, the key the compiler's events use.
  const byStart = new Map<string, { name: string; path: NodePath<t.Function> }>();
  const storeProxy = new Set([...info.imports].filter(([, imp]) => imp.name === "store" && /store\/inboxStore\.ts$/.test(imp.from)).map(([local]) => local));
  let mutable = new Set<string>();
  traverse(ast, {
    Program(p) { mutable = mutableModuleBindings(p); },
    Function(p) {
      const loc = p.node.loc?.start;
      if (!loc) return;
      let name = (p.node as t.FunctionDeclaration).id?.name ?? null;
      for (let up: NodePath | null = p.parentPath; !name && up; up = up.parentPath) {
        if (up.isVariableDeclarator() && t.isIdentifier(up.node.id)) name = up.node.id.name;
        else if (!up.isCallExpression()) break;
      }
      byStart.set(`${loc.line}:${loc.column}`, { name: name ?? "(anonymous)", path: p });
    },
  });
  const at = (loc: any) => (loc ? byStart.get(`${loc.start.line}:${loc.start.column}`) : undefined);

  const seenSkip = new Set<string>();
  const compiledHere = new Set<t.Function>();
  for (const e of events) {
    const fn = at(e.fnLoc);
    const line = e.fnLoc?.start.line ?? 0;
    if (e.kind === "CompileSuccess") {
      compiled.push({ file: rel(file), line, name: e.fnName ?? fn?.name ?? "(anonymous)", slots: e.memoSlots });
      if (fn) compiledHere.add(fn.path.node);
    } else if (e.kind === "CompileSkip" && /directive/.test(String(e.reason))) {
      // "use no memo": listed with its reason below, not as something the compiler gave up on.
    } else if (e.kind === "CompileError" || e.kind === "CompileSkip" || e.kind === "PipelineError") {
      const detail = e.detail?.options ?? e.detail ?? {};
      const reason = String(e.reason ?? detail.reason ?? e.data ?? "unknown").split(". See http")[0];
      const errLine = detail.loc?.start?.line ?? detail.details?.[0]?.loc?.start?.line ?? e.loc?.start?.line ?? null;
      const key = `${line}:${reason}`;
      if (seenSkip.has(key)) continue;
      seenSkip.add(key);
      skipped.push({ file: rel(file), line, name: fn?.name ?? "(anonymous)", category: String(detail.category ?? e.kind), reason, at: errLine });
    }
  }

  // "use no memo" is the compiler's opt-out; it reports nothing for those.
  for (const { name, path: p } of byStart.values()) {
    if (!hasNoMemo(p.node)) continue;
    // The reason is the comment the directive carries on its line.
    const directive = (p.node.body as t.BlockStatement).directives.find((d) => /^use no (memo|forget)$/.test(d.value.value))!;
    const why = code.split("\n")[directive.loc!.start.line - 1].split("//")[1]?.trim() ?? "(no reason given)";
    optedOut.push({ file: rel(file), line: p.node.loc!.start.line, name, why });
  }

  // Render-path reads in what compiled, and render-time getState() everywhere.
  for (const { name, path: p } of byStart.values()) {
    const isCompiled = compiledHere.has(p.node);
    const isComponentOrHook = /^(?:[A-Z]|use[A-Z])/.test(name);
    if (!isCompiled && !isComponentOrHook) continue;
    // A function nested in another compiled function is covered by its parent's walk.
    if (isCompiled && p.findParent((up) => up.isFunction() && compiledHere.has(up.node as t.Function))) continue;
    const { reads, calls } = scan(p, { file, storeProxy, mutable }, true);
    for (const read of reads) {
      if (read.what.endsWith(".getState()")) renderGetState.push({ file: rel(file), line: read.line, fn: name, compiled: isCompiled });
    }
    if (!isCompiled) continue;
    for (const read of reads) {
      if (!read.once && !reviewed(file, read.what)) hazards.push({ file: rel(file), line: read.line, fn: name, kind: read.kind, what: read.what, via: [] });
    }
    const callLines = new Map<string, number>();
    p.traverse({
      CallExpression(c) {
        const callee = c.node.callee;
        const key = t.isIdentifier(callee) ? callee.name : t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property) ? `${callee.object.name}.${callee.property.name}` : null;
        if (key && !callLines.has(key)) callLines.set(key, c.node.loc?.start.line ?? 0);
      },
    });
    // Functions a hook handed back (`const fmt = useX()`, `const { fmt } = useX()`,
    // `const [fmt] = useX()`), called on the render path.
    type Handed = { hook: string; info: FileInfo; whole?: Returned; fn?: Fn };
    const handed = new Map<object, Handed>();
    p.traverse({
      VariableDeclarator(d) {
        if (!d.node.init) return;
        const init = unwrap(d.get("init") as NodePath);
        if (!init.isCallExpression() || !isHookName(calleeName(init.node))) return;
        const call = asCall(init);
        const got = call && returnsOf(info, call);
        if (!got) return;
        const hook = calleeName(init.node)!;
        const bind = (local: string, entry: Omit<Handed, "hook" | "info">) => {
          const binding = d.scope.getBinding(local);
          if (binding) handed.set(binding, { hook, info: got.info, ...entry });
        };
        const id = d.node.id;
        if (t.isIdentifier(id)) bind(id.name, { whole: got.returned });
        else if (t.isObjectPattern(id)) {
          for (const prop of id.properties) {
            if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
            const local = t.isIdentifier(prop.value) ? prop.value.name : t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left) ? prop.value.left.name : null;
            const fn = got.returned.props.get(prop.key.name);
            if (local && fn) bind(local, { fn });
          }
        } else if (t.isArrayPattern(id)) {
          id.elements.forEach((el, i) => { const fn = got.returned.items.get(i); if (fn && t.isIdentifier(el)) bind(el.name, { fn }); });
        }
      },
    });
    {
      const told = new Set<string>();
      p.traverse({
        CallExpression(c) {
          for (let fn = c.getFunctionParent(); fn && fn.node !== p.node; fn = fn.getFunctionParent()) {
            if (!runsDuringRender(fn) || isStateInitializer(fn)) return;
          }
          const callee = c.node.callee;
          let from: Handed | undefined;
          let fn: Fn | undefined;
          let label = "";
          if (t.isIdentifier(callee)) {
            from = handed.get(c.scope.getBinding(callee.name) as object);
            fn = from?.fn ?? from?.whole?.self;
            label = callee.name;
          } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
            from = handed.get(c.scope.getBinding(callee.object.name) as object);
            fn = from?.whole?.props.get(callee.property.name);
            label = `${callee.object.name}.${callee.property.name}`;
          }
          const line = c.node.loc?.start.line ?? 0;
          if (t.isIdentifier(callee)) {
            const binding = c.scope.getBinding(callee.name);
            if (binding?.kind === "param" && binding.scope.path.node === p.node && !told.has(`${line}/${callee.name}/prop`)) {
              told.add(`${line}/${callee.name}/prop`);
              propCalls.push({ file: rel(file), line, fn: name, call: callee.name });
            }
          }
          if (!fn) {
            // Called, and it came from a hook, but nothing says what it does.
            const root = t.isIdentifier(callee) ? callee.name : t.isMemberExpression(callee) && t.isIdentifier(callee.object) ? callee.object.name : null;
            const decl = root ? c.scope.getBinding(root)?.path : null;
            const init = decl?.isVariableDeclarator() && decl.node.init ? unwrap(decl.get("init") as NodePath) : null;
            const hook = init?.isCallExpression() ? calleeName(init.node) : null;
            // `rows.map(…)`, `byId.get(…)`, `sig.split(…)` are data's own methods, not a function the hook made.
            const dataMethod = t.isMemberExpression(callee) && t.isIdentifier(callee.property) && DATA_METHODS.has(callee.property.name);
            if (isHookName(hook) && !KNOWN_RESULT.test(hook) && !dataMethod) {
              const call = t.isIdentifier(callee) ? callee.name : `${root}.${t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : "?"}`;
              if (!told.has(`${line}/${call}/unread`)) { told.add(`${line}/${call}/unread`); unread.push({ file: rel(file), line, fn: name, call, hook }); }
            }
            return;
          }
          if (!from) return;
          handedCallsRead++;
          for (const [kind, chain] of reachOf(from.info, fn, { args: c.node.arguments.length, maybe: maybeArgs(c) })) {
            const what = chain[chain.length - 1];
            if ((kind === "module" && REVIEWED_PURE[what]) || told.has(`${line}/${label}/${kind}`)) continue;
            told.add(`${line}/${label}/${kind}`);
            hazards.push({ file: rel(file), line, fn: name, kind, what, via: [`${label} (handed back by ${from.hook}())`, ...chain.slice(0, -1)] });
          }
        },
      });
    }
    const seen = new Set<string>();
    for (const call of calls) {
      const label = call.member ? `${call.local}.${call.member}` : call.local;
      const shape = `${label}/${call.args}/${call.maybe.join(",")}`;
      if (seen.has(shape)) continue;
      seen.add(shape);
      const target = resolveCall(info, call);
      if (!target || /^use[A-Z]/.test(target.fn.name) || target.fn.optedOut) continue;
      for (const [kind, chain] of reachOf(target.info, target.fn, call)) {
        if (kind === "module" && REVIEWED_PURE[chain[chain.length - 1]]) continue;
        hazards.push({ file: rel(file), line: callLines.get(label) ?? p.node.loc!.start.line, fn: name, kind, what: chain[chain.length - 1], via: [label, ...chain.slice(0, -1)] });
      }
    }
  }
}

// --- Output -----------------------------------------------------------------

if (flags.has("--json")) {
  console.log(JSON.stringify({ sources, files: targets.map(rel), compiled, skipped, optedOut, hazards, unread, handedCallsRead, propCalls, renderGetState, transformMs: Math.round(transformMs) }, null, 2));
  process.exit(hazards.length || unread.length ? 1 : 0);
}

const count = <T>(xs: T[], key: (x: T) => string) => [...xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
console.log(`React Compiler report for: ${sources.join(", ") || "(empty allowlist)"}`);
console.log(`${targets.length} files, ${compiled.length} functions compiled, ${new Set(skipped.map((s) => `${s.file}:${s.line}`)).size} left as written, ${optedOut.length} opted out ("use no memo"); compiler time ${Math.round(transformMs)} ms\n`);

if (flags.has("--compiled")) {
  console.log("Compiled:");
  for (const c of compiled) console.log(`  ${c.file}:${c.line}  ${c.name}  (${c.slots} cache slots)`);
  console.log("");
}

console.log(`Left as written by the compiler (${skipped.length}):`);
for (const [category, n] of count(skipped, (s) => s.category)) console.log(`  ${String(n).padStart(4)}  ${category}`);
for (const s of skipped) console.log(`  ${s.file}:${s.line}  ${s.name}  [${s.category}] ${s.reason}${s.at ? ` (line ${s.at})` : ""}`);

if (optedOut.length) {
  console.log(`\nOpted out with "use no memo" (${optedOut.length}):`);
  for (const o of optedOut) console.log(`  ${o.file}:${o.line}  ${o.name}  ${o.why}`);
}

console.log(`\nRender-time getState() calls: ${renderGetState.length} (${renderGetState.filter((r) => r.compiled).length} in compiled functions)`);
for (const r of renderGetState) console.log(`  ${r.file}:${r.line}  ${r.fn}  ${r.compiled ? "COMPILED: the read is cached" : "not compiled"}`);

console.log(`\nCalls while rendering to a function a hook handed back: ${handedCallsRead} read${unread.length ? `, ${unread.length} not readable` : ""}`);
if (unread.length) {
  console.log(`\nCalled while rendering, handed back by a hook this script could not read (${unread.length}); check each by hand:`);
  for (const u of unread) console.log(`  ${u.file}:${u.line}  ${u.fn}  ${u.call}(…) from ${u.hook}()`);
}

if (propCalls.length) {
  console.log(`\nProps called while rendering in compiled functions (${propCalls.length}); what each reads depends on who passes it, which this script does not follow:`);
  for (const c of propCalls) console.log(`  ${c.file}:${c.line}  ${c.fn}  ${c.call}(…)`);
}

console.log(`\nReads the compiler cannot see, in compiled functions (${hazards.length}):`);
for (const [kind, n] of count(hazards, (h) => h.kind)) console.log(`  ${String(n).padStart(4)}  ${kind}`);
for (const h of hazards) console.log(`  ${h.file}:${h.line}  ${h.fn}  [${h.kind}] ${[...h.via, h.what].join(" → ")}`);
process.exit(hazards.length || unread.length ? 1 : 0);
