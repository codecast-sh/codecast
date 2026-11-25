// A tiny evaluator for the conditions vimrcs branch on. It answers has(),
// exists(), v:version, &option and literals, combined with ! && || and
// comparisons. Anything else throws `UnknownCondition`, which the parser
// reports and treats as false.

import type { VimEnvironment } from "./types";

export class UnknownCondition extends Error {}

type V = number | string;

export interface ConditionContext {
  env: VimEnvironment;
  /** Current value of an option, or undefined when unknown. */
  option(name: string): V | boolean | undefined;
  optionExists(name: string): boolean;
  variableExists(name: string): boolean;
  commandExists(name: string): boolean;
}

const VERSION = 900;

function features(env: VimEnvironment): Record<string, boolean> {
  const mac = env.platform === "mac";
  const win = env.platform === "windows";
  return {
    nvim: false,
    vim: true,
    gui: true,
    gui_running: true,
    gui_macvim: false,
    gui_gtk: false,
    gui_gtk2: false,
    gui_gtk3: false,
    gui_win32: false,
    mac,
    macunix: mac,
    osx: mac,
    osx_darwin: mac,
    unix: !win,
    linux: env.platform === "linux",
    bsd: false,
    win32: win,
    win64: win,
    win95: false,
    win16: false,
    win32unix: false,
    wsl: false,
    clipboard: true,
    unnamedplus: true,
    syntax: true,
    autocmd: true,
    eval: true,
    folding: false,
    mouse: true,
    multi_byte: true,
    termguicolors: true,
    persistent_undo: true,
    extra_search: true,
    smartindent: true,
    wildmenu: false,
    vim_starting: true,
    vertsplit: true,
    windows: true,
    terminal: false,
    timers: true,
    lua: false,
    python: false,
    python3: false,
    pythonx: false,
    ruby: false,
    perl: false,
    conceal: false,
    "patch-8.0.0000": true,
  };
}

function hasFeature(env: VimEnvironment, name: string): number {
  const lower = name.toLowerCase();
  if (/^patch-?\d/.test(lower)) return 1;
  if (lower.startsWith("nvim-")) return 0;
  const table = features(env);
  if (lower in table) return table[lower] ? 1 : 0;
  throw new UnknownCondition(`has('${name}')`);
}

const TOKEN =
  /\s*(?:(\d+(?:\.\d+)?)|('(?:[^']|'')*')|("(?:[^"\\]|\\.)*")|(\|\||&&|==[#?]?|!=[#?]?|>=[#?]?|<=[#?]?|=~[#?]?|!~[#?]?|[<>][#?]?|isnot\b|is\b|[()!,.+\-*])|(&(?:[lg]:)?\w+|[a-zA-Z_][\w:#]*|\$\w+))/y;

function lex(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) throw new UnknownCondition(src.slice(i).trim());
    out.push(m[0].trim());
    i = TOKEN.lastIndex;
  }
  return out;
}

function str(lit: string): string {
  return lit[0] === "'" ? lit.slice(1, -1).replace(/''/g, "'") : lit.slice(1, -1).replace(/\\(.)/g, "$1");
}

const num = (v: V): number => (typeof v === "number" ? v : Number.parseInt(v, 10) || 0);

export function evaluateCondition(src: string, ctx: ConditionContext): boolean {
  const toks = lex(src);
  let pos = 0;
  const peek = () => toks[pos];
  const take = (t?: string) => {
    const tok = toks[pos++];
    if (t !== undefined && tok !== t) throw new UnknownCondition(src);
    return tok;
  };

  const or = (): V => {
    let v = and();
    while (peek() === "||") {
      take();
      const r = and();
      v = num(v) || num(r) ? 1 : 0;
    }
    return v;
  };
  const and = (): V => {
    let v = cmp();
    while (peek() === "&&") {
      take();
      const r = cmp();
      v = num(v) && num(r) ? 1 : 0;
    }
    return v;
  };
  const cmp = (): V => {
    const l = sum();
    const op = peek();
    if (!op || !/^(==|!=|>=|<=|=~|!~|[<>]|is|isnot)[#?]?$/.test(op)) return l;
    take();
    const r = sum();
    const base = op.replace(/[#?]$/, "");
    const ignoreCase = op.endsWith("?");
    if (base === "=~" || base === "!~") {
      let match: boolean;
      try {
        match = new RegExp(String(r), ignoreCase ? "i" : "").test(String(l));
      } catch {
        throw new UnknownCondition(src);
      }
      return (base === "=~") === match ? 1 : 0;
    }
    const bothStrings = typeof l === "string" && typeof r === "string";
    const a = bothStrings ? (ignoreCase ? l.toLowerCase() : l) : num(l);
    const b = bothStrings ? (ignoreCase ? (r as string).toLowerCase() : r) : num(r);
    switch (base) {
      case "==":
      case "is":
        return a === b ? 1 : 0;
      case "!=":
      case "isnot":
        return a !== b ? 1 : 0;
      case ">":
        return a > b ? 1 : 0;
      case "<":
        return a < b ? 1 : 0;
      case ">=":
        return a >= b ? 1 : 0;
      default:
        return a <= b ? 1 : 0;
    }
  };
  const sum = (): V => {
    let v = unary();
    while (peek() === "." || peek() === "+" || peek() === "-") {
      const op = take();
      const r = unary();
      v = op === "." ? `${v}${r}` : op === "+" ? num(v) + num(r) : num(v) - num(r);
    }
    return v;
  };
  const unary = (): V => {
    if (peek() === "!") {
      take();
      return num(unary()) ? 0 : 1;
    }
    if (peek() === "-") {
      take();
      return -num(unary());
    }
    return primary();
  };
  const primary = (): V => {
    const t = take();
    if (t === undefined) throw new UnknownCondition(src);
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (/^\d/.test(t)) return Number(t);
    if (t[0] === "'" || t[0] === '"') return str(t);
    if (t[0] === "&") {
      const v = ctx.option(t.replace(/^&(?:[lg]:)?/, ""));
      if (v === undefined) throw new UnknownCondition(t);
      return typeof v === "boolean" ? (v ? 1 : 0) : v;
    }
    if (t === "v:version") return VERSION;
    if (peek() === "(") {
      take("(");
      const args: V[] = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take();
        else break;
      }
      take(")");
      return call(t, args);
    }
    throw new UnknownCondition(t);
  };

  const call = (fn: string, args: V[]): V => {
    const a = String(args[0] ?? "");
    switch (fn) {
      case "has":
        return hasFeature(ctx.env, a);
      case "exists": {
        if (a.startsWith("+") || a.startsWith("&")) return ctx.optionExists(a.slice(1)) ? 1 : 0;
        if (a.startsWith(":")) return ctx.commandExists(a.slice(1)) ? 2 : 0;
        if (a.startsWith("*")) return 0;
        if (a.startsWith("$") || a.startsWith("##") || a.startsWith("#")) throw new UnknownCondition(`exists('${a}')`);
        return ctx.variableExists(a.includes(":") ? a : `g:${a}`) ? 1 : 0;
      }
      case "empty":
        return args[0] === "" || args[0] === 0 ? 1 : 0;
      default:
        throw new UnknownCondition(`${fn}()`);
    }
  };

  const v = or();
  if (pos < toks.length) throw new UnknownCondition(src);
  return num(v) !== 0;
}
