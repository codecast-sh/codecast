// The vimrc reader: structure (if/else, functions, augroups, plugin-manager
// blocks, heredocs) over translate.ts's one-command handlers.

import { logicalLines, splitCommands, type LogicalLine } from "./lines";
import {
  evaluate,
  handleAutocmd,
  handleCommand,
  handleLet,
  handleMap,
  handleOther,
  handleSet,
  mapFamily,
  newContext,
  type Entry,
  type TranslateCtx,
} from "./translate";
import type { ParsedDirective, ParsedSource, ParsedVimrc, VimEnvironment } from "./types";

export interface VimrcSourceInput {
  path: string;
  content: string;
  sourced_from?: string;
  truncated?: boolean;
  overlay?: boolean;
}

export function detectEnvironment(): VimEnvironment {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const p = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return { platform: /Mac|iPhone|iPad/.test(p) ? "mac" : /Win/.test(p) ? "windows" : "linux" };
}

const HEREDOC = /^(?:(lua|py(?:thon)?3?|pythonx|pyx|perl|ruby?|tcl|mz(?:scheme)?)|let\s+\S+\s*=)\s*<<\s*(trim\s+)?(\S*)\s*$/;
const FUNCTION = /^(fu(n(c(t(i(o(n)?)?)?)?)?)?!?|def!?)\s+\S/;
const END_FUNCTION = /^(endf(u(n(c(t(i(o(n)?)?)?)?)?)?)?|enddef)\b/;
const LOOP = /^(wh(i(l(e)?)?)?|for|try)\b/;
const END_LOOP = /^(endw(h(i(l(e)?)?)?)?|endfo(r)?|endt(r(y)?)?)\b/;
const IF = /^if\b\s*([\s\S]*)$/;
const ELSEIF = /^elsei(f)?\b\s*([\s\S]*)$/;
const ELSE = /^el(s(e)?)?\s*$/;
const ENDIF = /^en(d(i(f)?)?)?\s*$/;
const AUGROUP = /^aug(r(o(u(p)?)?)?)?!?\s+(\S+)/;
const PLUGIN_BEGIN = /^call\s+(plug|vundle|dein)#begin\b/;

const PLUGIN_NAMES: Array<[RegExp, string]> = [
  [/commentary|nerdcommenter|tcomment|comment\.nvim|caw/i, "commentary"],
  [/surround/i, "surround"],
  [/nerdtree|nvim-tree|neo-tree|fern|vinegar|chadtree|dirvish/i, "file tree"],
  [/ctrlp|fzf|telescope|leaderf|clap/i, "quick open"],
  [/fugitive|gitgutter|signify|gitsigns|diffview/i, "git"],
  [/\bale\b|coc\.nvim|lspconfig|vim-lsp|youcompleteme|languageclient/i, "language servers"],
  [/\/ack|ag\.vim|grepper|ctrlsf|ferret|vim-rg/i, "project search"],
  [/textobj-entire|indent-object|textobj-indent/i, "text objects"],
];

function pluginSummary(kind: string, lines: string[]): string {
  const plugins = lines.filter((l) => /^\s*(Plug|Plugin|Bundle|NeoBundle|use|call\s+(dein|minpac)#add)\b|^\s*['"][\w.-]+\/[\w.-]+['"]/.test(l));
  const built = new Set<string>();
  for (const l of plugins) for (const [re, name] of PLUGIN_NAMES) if (re.test(l)) built.add(name);
  const count = plugins.length ? `, ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}` : "";
  return `${kind} block${count}${built.size ? `; built in here: ${[...built].join(", ")}` : ""}`;
}

interface Branch {
  /** This branch runs. */
  active: boolean;
  /** Some branch of this if has run (later elseif/else do not). */
  taken: boolean;
  /** The enclosing branches all run. */
  outer: boolean;
}

const AUGROUP_END = /^aug(r(o(u(p)?)?)?)?\s+END\b/i;
const SWALLOWED_END = /\|\s*aug(r(o(u(p)?)?)?)?\s+END\s*$/i;
/** `autocmd!` with at most a group or an event and pattern: it only clears. */
const AUTOCMD_CLEAR = /^au(t(o(c(m(d)?)?)?)?)?!(\s+\S+){0,2}\s*$/;
const AUTOCMD = /^au(t(o(c(m(d)?)?)?)?)?!?\s+([\s\S]*)$/;

/** The index of the command closing a block opened at `parts[k]`, or -1. */
function closeInLine(parts: string[], k: number, end: RegExp, nest?: RegExp): number {
  for (let j = k + 1, depth = 0; j < parts.length; j++) {
    if (nest?.test(parts[j])) depth++;
    else if (end.test(parts[j]) && depth-- === 0) return j;
  }
  return -1;
}

function processSource(lines: LogicalLine[], ctx: TranslateCtx): ParsedDirective[] {
  const out: ParsedDirective[] = [];
  const push = (line: number, e: Entry) => out.push({ line, text: e.text, status: e.status, detail: e.detail, effects: e.effects });
  const branches: Branch[] = [];
  const running = () => branches.every((b) => b.active);
  // A branch not taken folds into one entry at its first line.
  let fold: { line: number; text: string; count: number; why: string } | null = null;
  const endFold = () => {
    if (fold && fold.count) push(fold.line, { text: fold.text, status: "skipped", detail: `branch not taken (${fold.why}; ${fold.count} line${fold.count === 1 ? "" : "s"})`, effects: [] });
    fold = null;
  };
  // Lines a fold has counted: a line of several commands counts once.
  let counted = -1;
  const tick = (i: number, n = 1) => {
    if (fold && counted !== i) fold.count += n;
    counted = i;
  };
  /** Where a branch body starts, for its fold entry: the rest of this line, or
   *  the next line that says something. */
  const bodyStart = (i: number, parts: string[], k: number) => {
    if (k + 1 < parts.length) return { line: lines[i].line, text: parts[k + 1] };
    let j = i + 1;
    while (j < lines.length && /^\s*("|$)/.test(lines[j].text)) j++;
    const l = lines[Math.min(j, lines.length - 1)];
    return { line: l.line, text: l.text.trim() };
  };
  const condition = (line: number, text: string, cond: string) => {
    const r = evaluate(cond, ctx);
    push(line, r.unknown ? { text, status: "skipped", detail: `can't evaluate ${r.unknown}; treated as false`, effects: [] } : { text, status: "applied", detail: r.value ? "true here" : "false here", effects: [] });
    return { active: r.value, why: r.unknown ? `${r.unknown} unknown` : `${cond.trim()} is false` };
  };

  /** Skip to the line closing a block; returns the index of that line. */
  const skipBlock = (from: number, end: RegExp, nest?: RegExp): number => {
    let depth = 0;
    for (let j = from + 1; j < lines.length; j++) {
      const t = lines[j].text.trim().replace(/^:+/, "");
      const here = HEREDOC.exec(t);
      if (here) {
        j = skipHeredoc(j, here);
        continue;
      }
      for (const p of splitCommands(t)) {
        if (nest?.test(p)) depth++;
        else if (end.test(p) && depth-- === 0) return j;
      }
    }
    return lines.length - 1;
  };
  const skipHeredoc = (from: number, m: RegExpExecArray): number => {
    const marker = m[3] || ".";
    for (let j = from + 1; j < lines.length; j++) {
      const t = m[2] ? lines[j].text.trim() : lines[j].text;
      if (t === marker || (!m[2] && lines[j].text.trimEnd() === marker)) return j;
    }
    return lines.length - 1;
  };

  lines: for (let i = 0; i < lines.length; i++) {
    const { line, text: raw } = lines[i];
    const whole = raw.trim().replace(/^:+\s*/, "");
    if (!whole || whole.startsWith('"') || whole.startsWith("#")) continue;

    // A heredoc's lines are another language's: never split them.
    const heredoc = HEREDOC.exec(whole);
    if (heredoc) {
      const end = skipHeredoc(i, heredoc);
      const body = lines.slice(i + 1, end).map((l) => l.text);
      if (running()) {
        const lang = heredoc[1] ?? "vimscript";
        const manager = /packer|lazy\.nvim|require\(["']lazy["']\)|paq|vim\.pack|mini\.deps/.test(body.join("\n"));
        push(line, { text: whole, status: "skipped", detail: manager ? pluginSummary("plugin manager", body) : `${lang} block (${body.length} lines)`, effects: [] });
      } else tick(i, end - i + 1);
      i = end;
      continue;
    }

    // Structure runs per command, so `if x | set y | endif` opens and closes
    // on one line, and a trailing comment never reaches a condition.
    const parts = splitCommands(whole);
    for (let k = 0; k < parts.length; k++) {
      const text = parts[k];
      const ifm = IF.exec(text);
      if (ifm && !/^if\w/.test(text)) {
        const outer = running();
        let active = false;
        if (outer) {
          const c = condition(line, text, ifm[1]);
          active = c.active;
          if (!active) fold = { ...bodyStart(i, parts, k), count: 0, why: c.why };
        } else tick(i);
        branches.push({ active, taken: active, outer });
        continue;
      }
      const top = branches[branches.length - 1];
      const elseif = ELSEIF.exec(text);
      if (top && (elseif || ELSE.test(text))) {
        if (!top.outer) {
          tick(i);
          continue;
        }
        endFold();
        let active = false;
        let why = "an earlier branch ran";
        if (!top.taken) {
          if (elseif) ({ active, why } = condition(line, text, elseif[2]));
          else active = true;
        }
        top.active = active;
        top.taken ||= active;
        if (!active) {
          fold = { ...bodyStart(i, parts, k), count: 0, why };
          counted = i;
        }
        continue;
      }
      if (top && ENDIF.test(text)) {
        if (top.outer) endFold();
        else tick(i);
        branches.pop();
        continue;
      }
      if (!running()) {
        tick(i);
        if (FUNCTION.test(text) && closeInLine(parts, k, END_FUNCTION, FUNCTION) < 0) {
          const end = skipBlock(i, END_FUNCTION, FUNCTION);
          if (fold) fold.count += end - i;
          i = end;
          continue lines;
        }
        continue;
      }

      const block = (end: RegExp, nest: RegExp | undefined, detail: (n: number) => string): boolean => {
        const j = closeInLine(parts, k, end, nest);
        if (j >= 0) {
          push(line, { text, status: "skipped", detail: detail(1), effects: [] });
          k = j;
          return false;
        }
        const last = skipBlock(i, end, nest);
        push(line, { text, status: "skipped", detail: detail(last - i + 1), effects: [] });
        i = last;
        return true;
      };
      if (FUNCTION.test(text)) {
        const name = /\s+([\w:#.<>]+)\s*\(/.exec(text)?.[1] ?? "";
        if (block(END_FUNCTION, FUNCTION, (n) => `vimscript function ${name} (${n} line${n === 1 ? "" : "s"})`)) continue lines;
        continue;
      }
      if (LOOP.test(text)) {
        const word = text.split(/\s/)[0];
        if (block(END_LOOP, LOOP, (n) => `vimscript ${word} block (${n} line${n === 1 ? "" : "s"})`)) continue lines;
        continue;
      }
      const begin = PLUGIN_BEGIN.exec(text);
      if (begin) {
        const end = skipBlock(i, new RegExp(`^call\\s+${begin[1]}#end\\b`));
        push(line, { text, status: "skipped", detail: pluginSummary(begin[1] === "plug" ? "vim-plug" : begin[1], lines.slice(i + 1, end).map((l) => l.text)), effects: [] });
        i = end;
        continue lines;
      }
      const aug = AUGROUP.exec(text);
      if (aug && !/^END$/i.test(aug[5])) {
        let others = 0;
        const children: Array<[number, Entry]> = [];
        const child = (t: string, at: number) => {
          if (!t || t.startsWith('"') || AUTOCMD_CLEAR.test(t)) return;
          const au = AUTOCMD.exec(t);
          if (au && /\bFileType\b/i.test(au[6])) for (const e of handleAutocmd(au[6], t, ctx)) children.push([at, e]);
          else others++;
        };
        const report = () => {
          const name = aug[5];
          push(line, others ? { text, status: "skipped", detail: `augroup ${name}: ${others} other line${others === 1 ? "" : "s"} skipped`, effects: [] } : { text, status: "applied", detail: `augroup ${name}`, effects: [] });
          for (const [l, e] of children) push(l, e);
        };
        const endHere = parts.findIndex((p, j) => j > k && AUGROUP_END.test(p));
        for (let j = k + 1; j < (endHere < 0 ? parts.length : endHere); j++) child(parts[j], line);
        if (endHere >= 0) {
          report();
          k = endHere;
          continue;
        }
        // The group's lines run up to its `augroup END`. When an autocmd's own
        // `|` swallowed it, or another group opens first, the group covers
        // only this line rather than everything up to some unrelated END.
        if (parts.slice(k + 1).some((p) => SWALLOWED_END.test(p))) {
          report();
          continue lines;
        }
        const commandsOf = (j: number) => splitCommands(lines[j].text.trim().replace(/^:+\s*/, ""));
        const opens = (p: string) => !AUGROUP_END.test(p) && AUGROUP.test(p);
        let close = i + 1;
        while (close < lines.length && !commandsOf(close).some((p) => AUGROUP_END.test(p) || opens(p))) close++;
        if (close === lines.length || !commandsOf(close).some((p) => AUGROUP_END.test(p))) {
          report();
          continue lines;
        }
        for (let j = i + 1; j < close; j++) for (const p of commandsOf(j)) child(p, lines[j].line);
        report();
        i = close;
        continue lines;
      }
      if (/^fini(s(h)?)?\b/.test(text)) {
        const rest = lines.slice(i + 1).filter((l) => l.text.trim() && !l.text.trim().startsWith('"'));
        if (rest.length) push(rest[0].line, { text: rest[0].text.trim(), status: "skipped", detail: `after :finish (${rest.length} lines)`, effects: [] });
        break lines;
      }

      for (const e of runCommand(text, ctx)) push(line, e);
    }
  }
  endFold();
  return out;
}

function runCommand(cmd: string, ctx: TranslateCtx): Entry[] {
  const m = /^([A-Za-z]+!?)\s*([\s\S]*)$/.exec(cmd);
  if (!m) return [{ text: cmd, status: "skipped", detail: "can't read this line", effects: [] }];
  const [, word, args] = m;
  const bare = word.replace(/!$/, "");
  const fam = mapFamily(word) ?? (word.endsWith("!") ? null : mapFamily(bare));
  if (fam && !/^m(a(r(k)?)?)?$/.test(word)) return [handleMap(word, fam, args, cmd, ctx)];
  if (/^(se(t)?|setl(o(c(a(l)?)?)?)?|setg(l(o(b(a(l)?)?)?)?)?)$/.test(bare)) return handleSet(bare.startsWith("setl") ? "setlocal" : bare.startsWith("setg") ? "setglobal" : "set", args, ctx);
  if (bare === "let") return [handleLet(args, cmd, ctx)];
  if (/^au(t(o(c(m(d)?)?)?)?)?$/.test(bare)) return handleAutocmd(args, cmd, ctx);
  if (/^com(m(a(n(d)?)?)?)?$/.test(bare)) return [handleCommand(args, cmd, ctx)];
  return [handleOther(word, args, cmd, ctx)];
}

/** Read vimrc sources in load order. Leaders, options and command aliases
 *  carry from one source to the next, as when vim sources them in turn. */
export function parseVimrc(sources: VimrcSourceInput[], env: VimEnvironment = detectEnvironment()): ParsedVimrc {
  const ctx = newContext(env);
  const parsed: ParsedSource[] = [];
  for (const src of sources) {
    ctx.sourcedHere = sources.some((s) => s.sourced_from === src.path);
    parsed.push({
      path: src.path,
      ...(src.sourced_from ? { sourcedFrom: src.sourced_from } : {}),
      ...(src.overlay ? { overlay: true } : {}),
      ...(src.truncated ? { truncated: true } : {}),
      directives: processSource(logicalLines(src.content), ctx),
    });
  }
  return { sources: parsed, options: { global: ctx.values, byFiletype: ctx.byFiletype }, leader: ctx.leader, localLeader: ctx.localLeader };
}
