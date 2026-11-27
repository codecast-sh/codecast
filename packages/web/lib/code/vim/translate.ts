// One vimrc command at a time, into report entries and effects. No vimscript
// runs: every command either maps onto something the editor has or is
// reported as skipped with the reason.

import { applySetArg, defaultOptionState, editorValues, isKnownOption, splitSetArgs, type OptionState, type SetResult } from "./options";
import { classifyEx, EXPAND_EX, isExCommandName, PROMPT_CARET, windowCommand, windowEngineKey } from "./exAdapters";
import { lhsKeys, tokenizeKeys, vimStringValue, type KeyToken } from "./keys";
import { stripMapComment } from "./lines";
import { plugKeys } from "./plugins";
import { withGdefault } from "./gdefault";
import { evaluateCondition, UnknownCondition } from "./expr";
import type { VimEffect, VimEnvironment, VimMapContext, VimOptionValues } from "./types";

export interface Entry {
  text: string;
  status: "applied" | "translated" | "skipped";
  detail: string;
  effects: VimEffect[];
}

export interface TranslateCtx {
  env: VimEnvironment;
  /** Leaders as engine keys (`<Space>`, `,`). */
  leader: string;
  localLeader: string;
  options: OptionState;
  ftOptions: Map<string, OptionState>;
  values: VimOptionValues;
  byFiletype: Record<string, VimOptionValues>;
  vars: Set<string>;
  aliases: Set<string>;
  mapped: Set<string>;
  /** Paths the daemon read because the current file sourced them. */
  sourcedHere: boolean;
}

export function newContext(env: VimEnvironment): TranslateCtx {
  return {
    env,
    leader: "\\",
    localLeader: "\\",
    options: defaultOptionState(),
    ftOptions: new Map(),
    values: {},
    byFiletype: {},
    vars: new Set(),
    aliases: new Set(),
    mapped: new Set(),
    sourcedHere: false,
  };
}

const entry = (text: string, status: Entry["status"], detail: string, effects: VimEffect[] = []): Entry => ({ text, status, detail, effects });
const skipped = (text: string, detail: string) => entry(text, "skipped", detail);

// ── conditions ──────────────────────────────────────────────────────────────

export function evaluate(cond: string, ctx: TranslateCtx): { value: boolean; unknown?: string } {
  try {
    return {
      value: evaluateCondition(cond, {
        env: ctx.env,
        option: (name) => (ctx.options.has(name) ? ctx.options.get(name) : undefined),
        optionExists: isKnownOption,
        variableExists: (name) => ctx.vars.has(name),
        commandExists: (name) => isExCommandName(name, ctx.aliases),
      }),
    };
  } catch (e) {
    if (e instanceof UnknownCondition) return { value: false, unknown: e.message };
    throw e;
  }
}

// ── :set ────────────────────────────────────────────────────────────────────

function setEffects(r: SetResult, state: OptionState): VimEffect[] {
  switch (r.name) {
    case "textwidth":
      return [{ kind: "engineOption", name: "textwidth", value: Number(r.value) }];
    case "langmap":
      return [{ kind: "engineOption", name: "langmap", value: String(r.value) }];
    case "gdefault":
      return [{ kind: "engineOption", name: "gdefault", value: !!r.value }];
    case "timeout":
    case "timeoutlen":
      return [{ kind: "timeout", ms: state.get("timeout") ? Number(state.get("timeoutlen")) : null }];
    case "clipboard":
      return [{ kind: "clipboard", on: /unnamed/.test(String(r.value)) }];
    default:
      return [];
  }
}

export function handleSet(cmd: string, args: string, ctx: TranslateCtx, filetypes?: string[]): Entry[] {
  const list = splitSetArgs(args);
  if (!list.length) return [skipped(cmd, "only lists options")];
  const out: Entry[] = [];
  for (const arg of list) {
    if (filetypes) {
      let result: SetResult | null = null;
      for (const ft of filetypes) {
        let state = ctx.ftOptions.get(ft);
        if (!state) {
          state = new Map(ctx.options);
          ctx.ftOptions.set(ft, state);
        }
        result = applySetArg(arg, state, cmd);
        if (result.role === "editor") editorValues([result], (ctx.byFiletype[ft] ??= {}));
      }
      const r = result!;
      const local = r.role === "editor" || r.status === "skipped";
      out.push(entry(r.text, local ? r.status : "skipped", local ? r.detail : "only editor options apply per language"));
      continue;
    }
    const r = applySetArg(arg, ctx.options, cmd);
    editorValues([r], ctx.values);
    out.push(entry(r.text, r.status, r.detail, r.status === "skipped" ? [] : setEffects(r, ctx.options)));
  }
  return out;
}

// ── maps ────────────────────────────────────────────────────────────────────

interface MapFamily {
  modes: string;
  noremap: boolean;
  unmap?: boolean;
  abbrev?: boolean;
}

const FAMILIES: Array<[RegExp, MapFamily]> = [];
function family(re: string, f: MapFamily) {
  FAMILIES.push([new RegExp(`^(?:${re})$`), f]);
}
const ab = (full: string, min: number) => {
  let re = full.slice(0, min);
  for (const c of full.slice(min)) re += `(?:${c}`;
  return re + ")?".repeat(full.length - min);
};
family(`${ab("map", 3)}!`, { modes: "ic", noremap: false });
family(`${ab("noremap", 2)}!`, { modes: "ic", noremap: true });
family(`${ab("unmap", 3)}!`, { modes: "ic", noremap: false, unmap: true });
family(ab("map", 3), { modes: "nvo", noremap: false });
family(ab("noremap", 2), { modes: "nvo", noremap: true });
family(ab("unmap", 3), { modes: "nvo", noremap: false, unmap: true });
for (const [p, m, nore, un, modes] of [
  ["n", 2, 2, 3, "n"],
  ["v", 2, 2, 2, "vs"],
  ["x", 2, 2, 2, "x"],
  ["s", 4, 4, 4, "s"],
  ["o", 2, 3, 2, "o"],
  ["i", 2, 3, 2, "i"],
  ["l", 2, 2, 2, "l"],
  ["c", 2, 3, 2, "c"],
  ["t", 3, 3, 5, "t"],
] as const) {
  family(ab(`${p}map`, m), { modes, noremap: false });
  family(ab(`${p}noremap`, nore), { modes, noremap: true });
  family(ab(`${p}unmap`, un), { modes, noremap: false, unmap: true });
}
family(ab("abbreviate", 2), { modes: "ic", noremap: false, abbrev: true });
family(ab("noreabbrev", 5), { modes: "ic", noremap: true, abbrev: true });
family(ab("iabbrev", 2), { modes: "i", noremap: false, abbrev: true });
family(ab("inoreabbrev", 6), { modes: "i", noremap: true, abbrev: true });
family(ab("cabbrev", 2), { modes: "c", noremap: false, abbrev: true });
family(ab("cnoreabbrev", 6), { modes: "c", noremap: true, abbrev: true });

export function mapFamily(word: string): MapFamily | null {
  for (const [re, f] of FAMILIES) if (re.test(word)) return f;
  return null;
}

const CONTEXTS: Record<string, VimMapContext> = { n: "normal", x: "visual", v: "visual", o: "operatorPending", i: "insert" };
const UNSUPPORTED_MODE: Record<string, string> = {
  c: "command-line maps aren't supported",
  s: "select mode doesn't exist here",
  l: "language maps aren't supported",
  t: "terminal maps don't apply here",
};

function contextsFor(modes: string): { contexts: VimMapContext[]; dropped: string[] } {
  if (modes.startsWith("nvo")) return { contexts: [undefined], dropped: [] };
  const contexts: VimMapContext[] = [];
  const dropped: string[] = [];
  for (const m of modes) {
    if (m === "s" && modes.includes("v")) continue;
    if (m in CONTEXTS) contexts.push(CONTEXTS[m]);
    else dropped.push(m);
  }
  return { contexts, dropped };
}

const MODE_LABEL: Record<string, string> = { normal: "normal", visual: "visual", operatorPending: "op-pending", insert: "insert" };
const label = (contexts: VimMapContext[]) => contexts.map((c) => (c ? MODE_LABEL[c] : "normal, visual, op-pending")).join(", ");

/** Keys vim reads one literal character after, so `f:` is not an ex command. */
const TAKES_CHAR = new Set(["f", "F", "t", "T", "r", "m", "'", "`", "q", "@", '"']);
const ENTERS_INSERT = new Set(["i", "a", "o", "I", "A", "O", "s", "S", "C"]);
const OPERATORS = new Set(["y", "d", "c", "<", ">", "=", "!"]);
const LEAVES_INSERT = new Set(["<Esc>", "<C-c>", "<C-[>"]);

interface Rhs {
  keys: string;
  translated: string[];
  skip?: string;
  usesCommandKeys: boolean;
  /** Why parts of a right side that otherwise runs do nothing here. */
  missing?: string[];
}

function keyString(tok: KeyToken, ctx: TranslateCtx): string | { skip: string } {
  switch (tok.kind) {
    case "key":
      return tok.keys;
    case "leader":
      return tok.local ? ctx.localLeader : ctx.leader;
    case "nop":
      return "";
    case "cmd":
      return ":";
    case "plug": {
      const keys = plugKeys(tok.name);
      return keys ?? { skip: `<Plug>${tok.name} isn't built in here` };
    }
    case "unsupported":
      return { skip: `${tok.name} isn't supported` };
  }
}

/** The keys an ex segment types into the command line, in the order the
 *  text ends up. The prompt a map types into appends every key and ignores
 *  caret motion, so `<Left>`, `<Right>`, `<Home>` and `<End>` are played out
 *  here; a line left open gets PROMPT_CARET where they leave the caret. A
 *  bare `<` goes as `<lt>`: the prompt takes `<` for the start of a key name
 *  and drops it. */
export function promptKeys(keys: string[], closed: boolean): string {
  const units: string[] = [];
  let caret = 0;
  for (let j = 0; j < keys.length; j++) {
    const k = keys[j];
    if (k === "<Left>") caret = Math.max(0, caret - 1);
    else if (k === "<Right>") caret = Math.min(units.length, caret + 1);
    else if (k === "<Home>" || k === "<C-b>") caret = 0;
    else if (k === "<End>" || k === "<C-e>") caret = units.length;
    else if (k === "<BS>") {
      if (caret > 0) units.splice(--caret, 1);
    } else if (k === "<C-u>") {
      units.splice(0, caret);
      caret = 0;
    } else {
      let unit = k === "<" ? "<lt>" : k;
      // <C-r>x is one unit: the register or word it names fills in later.
      if (/^<C-r>$/i.test(k)) {
        if (/^<C-[rop]>$/i.test(keys[j + 1] ?? "")) unit += keys[++j];
        if (j + 1 < keys.length) unit += keys[++j];
      }
      units.splice(caret++, 0, unit);
    }
  }
  if (!closed && caret < units.length) units.splice(caret, 0, PROMPT_CARET);
  return units.join("");
}

/** An ex segment of a right-hand side, `:Foo bar` up to its <CR>. */
function translateEx(text: string, closed: boolean, ctx: TranslateCtx): { keys: string; translated?: string } | { skip: string } {
  let body = text.replace(/^(<C-u>)+/i, "");
  // `:exe "Rg " . expand("<cword>")` is the common way to grep the word.
  const exe = /^\s*exe(?:c(?:ute)?)?\s+(['"])(.*?)\1\s*\.\s*expand\(\s*(['"])<cword>\3\s*\)\s*$/.exec(body);
  if (exe) body = `${exe[2]}<C-r><C-w>`;
  const cls = classifyEx(body, ctx.aliases);
  if (cls.kind === "skip") return { skip: cls.reason === "runs vimscript" ? `runs vimscript (:${cls.name})` : cls.reason };
  const end = closed ? "<CR>" : "";
  // A substitute runs through Vim.handleEx too, where gdefault applies.
  const needsExpand = closed && cls.kind !== "adapter" && (/<C-r>/i.test(body) || withGdefault(body) !== body);
  const keys = needsExpand ? `:${EXPAND_EX} ${body}${end}` : `:${body}${end}`;
  // An absolute path opens only when it sits inside the folder the editor has
  // open, which the report can't know.
  const outside = cls.kind === "adapter" && cls.command === "file.open" && String(cls.args?.path ?? "").startsWith("/");
  return { keys, translated: cls.kind === "adapter" ? (outside ? "file.open (inside the open folder only)" : cls.command) : cls.kind === "alias" ? `:${cls.name}` : undefined };
}

export function translateRhs(raw: string, insert: boolean, ctx: TranslateCtx): Rhs {
  const toks = tokenizeKeys(raw);
  const out: string[] = [];
  const translated: string[] = [];
  let inInsert = insert;
  let oneNormal = false;
  let op: string | null = null;
  let usesCommandKeys = false;
  let segment: string[] | null = null;
  const missing: string[] = [];

  // The quickfix window a `:copen` just opened, which a `:q` right after it
  // closes in vim. Here the results open in the search pane and stay; the
  // `:q` would close the file instead, so it is dropped.
  let quickfixOpen = false;
  const closeSegment = (closed: boolean): string | null => {
    const line = promptKeys(segment!, closed);
    segment = null;
    const word = /^[\s:]*([A-Za-z]+)/.exec(line)?.[1] ?? "";
    if (quickfixOpen && closed && /^(q(u(it?)?)?|clo(se?)?)$/.test(word)) {
      quickfixOpen = false;
      missing.push(`:${word} after the quickfix list closes nothing here`);
      return null;
    }
    const r = translateEx(line, closed, ctx);
    if ("skip" in r) return r.skip;
    out.push(r.keys);
    if (r.translated) translated.push(r.translated);
    quickfixOpen = /^(cope(n)?|cw(indow)?|lop(en)?|lw(indow)?)$/.test(word);
    return null;
  };

  for (let i = 0; i < toks.length; i++) {
    const k = keyString(toks[i], ctx);
    if (typeof k !== "string") return { keys: "", translated, skip: k.skip, usesCommandKeys };
    if (segment) {
      if (k === "<CR>" || k === "<C-m>") {
        const skip = closeSegment(true);
        if (skip) return { keys: "", translated, skip, usesCommandKeys };
      } else if (k === "<Esc>" || k === "<C-c>") {
        segment = null;
        out.push(k);
      } else segment.push(k);
      continue;
    }
    const normalHere = !inInsert || oneNormal;
    if (toks[i].kind === "cmd" || (k === ":" && normalHere)) {
      segment = [];
      if (inInsert && !oneNormal) out.push("<C-o>");
      oneNormal = false;
      continue;
    }
    // `<C-w>x` becomes its window binding's engine key (plugins.ts), which a
    // count before it reaches; a noremap only sees the engine's own keys, so
    // the right side is played as a map. A key with no command plays nothing.
    if (normalHere && k === "<C-w>" && i + 1 < toks.length) {
      const next = keyString(toks[i + 1], ctx);
      if (typeof next !== "string") return { keys: "", translated, skip: next.skip, usesCommandKeys };
      const win = windowCommand(next);
      if ("command" in win) {
        translated.push(win.command);
        out.push(windowEngineKey(next)!);
      } else missing.push(win.skip);
      usesCommandKeys = true;
      i++;
      continue;
    }
    if (k.startsWith("<Cc")) usesCommandKeys = true;
    out.push(k);
    if (inInsert && !oneNormal) {
      if (LEAVES_INSERT.has(k)) inInsert = false;
      else if (k === "<C-o>") oneNormal = true;
    } else if (op) {
      // The operator's motion: a text object takes one more key, f/t/... one more.
      if ((k === "i" || k === "a" || TAKES_CHAR.has(k)) && i + 1 < toks.length) out.push(String(keyString(toks[++i], ctx)));
      if (op === "c" && !/^\d$/.test(k)) inInsert = true;
      if (!/^\d$/.test(k)) op = null;
    } else if (TAKES_CHAR.has(k) && i + 1 < toks.length) {
      out.push(String(keyString(toks[++i], ctx)));
      oneNormal = false;
    } else if (OPERATORS.has(k)) {
      op = k;
      oneNormal = false;
    } else {
      if (ENTERS_INSERT.has(k)) inInsert = true;
      oneNormal = false;
    }
  }
  if (segment) {
    const skip = closeSegment(false);
    if (skip) return { keys: "", translated, skip, usesCommandKeys };
  }
  // Only window keys, none of them here: the map would do nothing.
  if (missing.length && !translated.length && out.every((o) => /^\d+$/.test(o))) {
    return { keys: "", translated, skip: missing[0], usesCommandKeys };
  }
  return { keys: out.join(""), translated, usesCommandKeys, missing };
}

function displayKeys(raw: string): string {
  return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
}

function lhsFrom(raw: string, ctx: TranslateCtx): string | { skip: string } {
  let keys = "";
  for (const tok of tokenizeKeys(raw)) {
    if (tok.kind === "plug") return { skip: "defines a <Plug> name" };
    const k = keyString(tok, ctx);
    if (typeof k !== "string") return k;
    keys += k;
  }
  return lhsKeys(keys);
}

const FLAG = /^<(buffer|nowait|silent|special|script|expr|unique)>\s*/i;

export function handleMap(word: string, f: MapFamily, args: string, text: string, ctx: TranslateCtx): Entry {
  let rest = args.trim();
  const flags = new Set<string>();
  for (let m; (m = FLAG.exec(rest)); rest = rest.slice(m[0].length)) flags.add(m[1].toLowerCase());
  if (flags.has("expr")) return skipped(text, "<expr> maps compute their keys in vimscript");

  if (f.abbrev) return handleAbbrev(f, rest, text, ctx);

  const lhsMatch = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (!lhsMatch) return skipped(text, "only lists maps");
  const [, lhsRaw, rhsAll] = lhsMatch;
  const { contexts, dropped } = contextsFor(f.modes);
  if (!contexts.length) return skipped(text, UNSUPPORTED_MODE[dropped[0]] ?? "this mode isn't supported");

  const lhs = lhsFrom(lhsRaw.replace(/\\\|/g, "|"), ctx);
  if (typeof lhs !== "string") return skipped(text, lhs.skip);

  if (f.unmap) {
    const effects: VimEffect[] = [];
    for (const c of contexts) {
      const key = `${c ?? ""}|${lhs}`;
      if (ctx.mapped.has(key)) {
        ctx.mapped.delete(key);
        effects.push({ kind: "unmap", context: c, lhs });
      }
    }
    return effects.length ? entry(text, "applied", `removes ${lhsRaw}`, effects) : skipped(text, "built-in keys stay; only this vimrc's maps can be removed");
  }

  const rhsRaw = stripMapComment(rhsAll).replace(/\\\|/g, "|");
  if (!rhsRaw) return skipped(text, "only lists the map");
  const rhs = translateRhs(rhsRaw, contexts.every((c) => c === "insert"), ctx);
  if (rhs.skip) return skipped(text, rhs.skip);
  const missing = rhs.missing ?? [];
  // A noremap's right side only sees built-in keys; the window and plugin
  // keys here are maps, so let it reach them.
  // A map whose right side starts with its left side (`map O O<Space><BS>`)
  // runs those first keys as built in, as vim does; the engine's recursion
  // guard would drop them instead and run the rest in the wrong mode.
  const selfPrefixed = !f.noremap && rhs.keys.startsWith(lhs);
  const noremap = (f.noremap || selfPrefixed) && !rhs.usesCommandKeys && !/<Cc\w+>/.test(rhs.keys);
  const effects: VimEffect[] = contexts.map((context) => ({ kind: "map", context, lhs, rhs: rhs.keys, noremap, nowait: flags.has("nowait") }));
  for (const c of contexts) ctx.mapped.add(`${c ?? ""}|${lhs}`);
  const notes: string[] = [];
  if (rhs.translated.length) notes.push(`→ ${[...new Set(rhs.translated)].join(", ")}`);
  if (missing.length) notes.push(`(${[...new Set(missing)].join(", ")})`);
  if (dropped.length) notes.push(`(${UNSUPPORTED_MODE[dropped[0]] ?? "some modes dropped"})`);
  const status = notes.length ? "translated" : "applied";
  return entry(text, status, `${label(contexts)}: ${displayKeys(lhsRaw)}${notes.length ? ` ${notes.join(" ")}` : ""}`, effects);
}

function handleAbbrev(f: MapFamily, rest: string, text: string, ctx: TranslateCtx): Entry {
  if (!f.modes.includes("c")) return skipped(text, "insert abbreviations aren't supported");
  const m = /^(\w+)\s+([\s\S]+)$/.exec(rest);
  if (!m) return skipped(text, "can't read this abbreviation");
  const [, name, body] = m;
  if (isExCommandName(name, new Set())) return skipped(text, `would shadow :${name}`);
  const cls = classifyEx(body, ctx.aliases);
  if (cls.kind === "skip") return skipped(text, cls.reason);
  ctx.aliases.add(name);
  return entry(text, "translated", `ex alias :${name} → :${body.trim()}${f.modes === "c" ? "" : " (insert part dropped)"}`, [
    { kind: "exAlias", name, body: body.trim() },
  ]);
}

// ── :command ────────────────────────────────────────────────────────────────

export function handleCommand(args: string, text: string, ctx: TranslateCtx): Entry {
  let rest = args.trim();
  for (let m; (m = /^-\w+(?:=\S*)?\s+/.exec(rest)); rest = rest.slice(m[0].length));
  const m = /^([A-Z]\w*)\s+([\s\S]+)$/.exec(rest);
  if (!m) return skipped(text, rest ? "can't read this command" : "only lists commands");
  const [, name, rawBody] = m;
  const body = rawBody.trim().replace(/^:+/, "");
  const cls = classifyEx(body.replace(/<[qf]-args>|<args>/gi, "").replace(/^<line1>(,<line2>)?\s*/i, ""), ctx.aliases);
  if (cls.kind === "skip") return skipped(text, cls.reason === "runs vimscript" ? `runs vimscript (:${cls.name})` : cls.reason);
  if (/<(line[12]|count|reg|mods|range|bang)>/i.test(body)) return skipped(text, "uses ranges, counts or a bang");
  if (/\|/.test(body.replace(/<bar>/gi, ""))) return skipped(text, "runs several commands");
  ctx.aliases.add(name);
  return entry(text, "translated", `ex alias :${name} → :${body}${cls.kind === "adapter" ? ` (${cls.command})` : ""}`, [{ kind: "exAlias", name, body }]);
}

// ── :let ────────────────────────────────────────────────────────────────────

export function handleLet(args: string, text: string, ctx: TranslateCtx): Entry {
  const leader = /^(?:g:)?(mapleader|maplocalleader)\s*=\s*([\s\S]+)$/.exec(args.trim());
  if (leader) {
    const value = vimStringValue(leader[2]);
    if (value === null || value === "") return skipped(text, "can't read the leader's value");
    const keys = lhsFrom(value, ctx);
    if (typeof keys !== "string") return skipped(text, keys.skip);
    if (leader[1] === "mapleader") ctx.leader = keys;
    else ctx.localLeader = keys;
    ctx.vars.add(`g:${leader[1]}`);
    return entry(text, "applied", `${leader[1] === "mapleader" ? "<leader>" : "<localleader>"} is ${keys}`);
  }
  const opt = /^&(?:[lg]:)?(\w+)\s*([-+^]?=)\s*([\s\S]+)$/.exec(args.trim());
  if (opt) {
    const raw = opt[3].trim();
    const value = vimStringValue(raw) ?? (/^-?\d+$/.test(raw) ? raw : null);
    if (value === null) {
      const probe = applySetArg(`${opt[1]}=0`, new Map(ctx.options), "let");
      return skipped(text, probe.status === "skipped" ? probe.detail : "the value is an expression");
    }
    const results = handleSet("let", `${opt[1]}${opt[2]}${value.replace(/ /g, "\\ ")}`, ctx);
    return { ...results[0], text };
  }
  const v = /^([gsbwtvl]:)?([\w#.]+)/.exec(args.trim());
  if (v && (!v[1] || v[1] === "g:")) {
    ctx.vars.add(`g:${v[2]}`);
    return skipped(text, "plugin setting");
  }
  if (/^\$/.test(args.trim())) return skipped(text, "environment variable");
  return skipped(text, "vimscript variable");
}

// ── :autocmd ────────────────────────────────────────────────────────────────

const EVENTS = /^(Buf\w+|File\w+|Vim\w+|Win\w+|Tab\w+|Insert\w+|Cursor\w+|Text\w+|Cmd\w+|Color\w+|Focus\w+|Term\w+|Shell\w+|Swap\w+|Quickfix\w+|Session\w+|Mode\w+|Option\w+|Complete\w+|Lsp\w+|User|Syntax|Signal\w*|Search\w+|Diff\w+|Dir\w+|SourcePre|SourcePost|SourceCmd|SpellFileMissing|StdinReadPost|StdinReadPre|EncodingChanged|GUIEnter|GUIFailed|MenuPopup|RemoteReply|SafeState\w*|\*)(,|$)/;

export function handleAutocmd(args: string, text: string, ctx: TranslateCtx): Entry[] {
  let rest = args.trim();
  const words = rest.split(/\s+/);
  if (words[0] && !EVENTS.test(words[0]) && words[1] && EVENTS.test(words[1])) rest = rest.slice(words[0].length).trim();
  const m = /^(\S+)\s+(\S+)\s+(?:(?:\+\+once|\+\+nested|nested)\s+)*([\s\S]+)$/.exec(rest);
  if (!m) return [skipped(text, "clears autocmds")];
  const [, events, pattern, command] = m;
  if (!/^FileType$/i.test(events)) {
    if (/set(l(ocal)?)?\s+(ft|filetype)=/.test(command)) return [skipped(text, "filetypes are detected from the file")];
    return [skipped(text, `${events.split(",")[0]} autocmds don't run here`)];
  }
  const every = pattern === "*";
  const filetypes = every ? [] : pattern.split(",").filter((p) => /^[\w.-]+$/.test(p));
  if (!every && !filetypes.length) return [skipped(text, "pattern names no filetype")];
  const parts = command.split(/\s*\|\s*/).filter(Boolean);
  const done: string[] = [];
  const dropped: string[] = [];
  for (const part of parts) {
    const set = /^:?(?:setl(?:o(?:c(?:a(?:l)?)?)?)?|se(?:t)?)\s+([\s\S]+)$/.exec(part.trim());
    if (!set) {
      dropped.push(part.trim().split(/\s+/)[0]);
      continue;
    }
    for (const r of handleSet("setlocal", set[1], ctx, every ? undefined : filetypes)) {
      if (r.status === "skipped") dropped.push(`${r.text.replace(/^setlocal /, "")} (${r.detail})`);
      else done.push(r.text.replace(/^setlocal /, ""));
    }
  }
  const fts = every ? "every filetype" : filetypes.join(", ");
  if (!done.length) return [skipped(text, dropped.length ? `nothing applies per language: ${dropped.join(", ")}` : "nothing to apply")];
  return [entry(text, "translated", `${fts}: ${done.join(" ")}${dropped.length ? `; skipped ${dropped.join(", ")}` : ""}`)];
}

// ── everything else ─────────────────────────────────────────────────────────

const PLUGIN_LINE = /^(Plug|Plugin|Bundle|NeoBundle|NeoBundleFetch|call\s+(dein|minpac|plug|vundle)#\w+)\b/;

export function handleOther(word: string, args: string, text: string, ctx: TranslateCtx): Entry {
  const w = word.replace(/!$/, "");
  const is = (full: string, min: number) => w.length >= min && full.startsWith(w);
  if (PLUGIN_LINE.test(text)) return skipped(text, "plugin manager entry");
  if (is("filetype", 5)) return /\boff\b/.test(args) ? skipped(text, "filetype detection is always on") : entry(text, "applied", "detection, plugins and indent are always on");
  if (is("syntax", 2)) {
    if (/^(on|enable)\b/.test(args.trim()) || !args.trim()) return entry(text, "applied", "highlighting is always on");
    return skipped(text, args.trim() === "off" ? "highlighting is always on" : "highlighting comes from the language");
  }
  if (is("colorscheme", 4) || is("highlight", 2)) return skipped(text, "the app's theme colors the editor");
  if (is("source", 2) || is("runtime", 2)) {
    if (is("runtime", 2)) return skipped(text, "runtime files aren't read");
    return ctx.sourcedHere ? entry(text, "applied", "read as its own source") : skipped(text, "file not read (outside home or missing)");
  }
  if (is("call", 3)) return skipped(text, "calls a vimscript function");
  if (is("execute", 3)) return skipped(text, "runs vimscript");
  if (/^echo(m(sg)?|e(rr)?|hl|n)?$|^ec$/.test(w)) return skipped(text, "prints a message");
  if (is("packadd", 2) || is("packloadall", 5)) return skipped(text, "plugin loading");
  if (w === "lua" || is("luafile", 4)) return skipped(text, "runs lua");
  if (/^(py(thon)?3?|pyx|pythonx|py3file|pyfile|perl|ruby?|rubyfile|tcl|mzscheme)$/.test(w)) return skipped(text, "runs another language");
  if (is("scriptencoding", 7) || is("language", 3) || is("behave", 2)) return skipped(text, "not applicable in the browser");
  if (is("normal", 4)) return skipped(text, "runs keys at startup");
  if (is("nohlsearch", 3) || is("redraw", 4) || is("sleep", 2) || is("messages", 3)) return skipped(text, "only meaningful while editing");
  if (is("delcommand", 4) || is("comclear", 4)) return skipped(text, "built-in commands stay");
  if (/^[nvxsoilct]?mapc(l(e(a(r)?)?)?)?$/.test(w)) return skipped(text, "clearing maps isn't supported");
  if (/^(a|n|v|x|s|o|i|c|t)?(nore)?me(n(u)?)?$|^(a|n|v|i|c)?unme(n(u)?)?$|^macm(e(n(u)?)?)?$|^am(e(n(u)?)?)?$|^an(o(r(e(m(e(n(u)?)?)?)?)?)?)?$|^tm(e(n(u)?)?)?$|^tu(n(m(e(n(u)?)?)?)?)?$/.test(w)) {
    return skipped(text, "menus don't apply here");
  }
  if (/^(sig(n)?|mat(c(h)?)?|[23]mat(c(h)?)?|dig(r(a(p(h(s)?)?)?)?)?|helpt(a(g(s)?)?)?|cd|lc(d)?|chd(i(r)?)?|tc(d)?|winc(m(d)?)?|wi(n(s(i(z(e)?)?)?)?)?|winp(o(s)?)?)$/.test(w)) {
    return skipped(text, "not applicable here");
  }
  if (/^(una(b(b(r(e(v(i(a(t(e)?)?)?)?)?)?)?)?)?|[ic]una(b(b(r(e(v)?)?)?)?)?)$/.test(w)) return skipped(text, "abbreviations aren't supported");
  if (/^(retu(r(n)?)?|fini(s(h)?)?|endf(u(n(c(t(i(o(n)?)?)?)?)?)?)?|en(d(i(f)?)?)?|endfo(r)?|endw(h(i(l(e)?)?)?)?|endt(r(y)?)?|aug(r(o(u(p)?)?)?)?)$/.test(w)) {
    return skipped(text, "out of place");
  }
  const cls = classifyEx(text, ctx.aliases);
  if (cls.kind !== "skip") return skipped(text, "runs once at startup in vim");
  return skipped(text, cls.reason.endsWith("isn't available here") ? "unknown command" : cls.reason);
}
