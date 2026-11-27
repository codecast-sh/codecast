// Vim's 'gdefault': with it on, `:s/a/b/` replaces every match on a line and
// `:s/a/b/g` only the first. The engine has no such option and its
// substitute can't be wrapped (defining `:s` replaces it), so a command line
// has its `g` flag flipped on the way in, at each door one can reach the
// engine through: Vim.handleEx (adapters, maps routed through CodecastEx),
// and the `:` prompt a person types into (index.ts).

import { Vim } from "@replit/codemirror-vim";

const RANGE = /^[\s:]*(?:(?:[%.$]|\d+|'[a-zA-Z<>]|[+-]\d*)(?:\s*[,;]\s*(?:[.$]|\d+|'[a-zA-Z<>]|[+-]\d*))*)?\s*/;
// `s` and each longer spelling of `substitute`, followed by its delimiter.
const SUBSTITUTE = /^s(?:u(?:b(?:s(?:t(?:i(?:t(?:u(?:te?)?)?)?)?)?)?)?)?(?=[^\w\s\\"|])/;
const GLOBAL = /^(?:g(?:l(?:o(?:b(?:al?)?)?)?)?!?|v(?:g(?:l(?:o(?:b(?:al?)?)?)?)?)?)(?=[^\w\s\\"|])/;

/** The index just past the next unescaped `delim` from `from`, or -1. */
function skipTo(text: string, from: number, delim: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === delim) return i + 1;
  }
  return -1;
}

/** `line` as vim runs it with gdefault on: a substitute's `g` flag flipped,
 *  inside `:g/pat/s//` too. Anything else comes back unchanged. */
export function withGdefault(line: string): string {
  const range = RANGE.exec(line)![0];
  const body = line.slice(range.length);
  const global = GLOBAL.exec(body);
  if (global) {
    const delim = body[global[0].length];
    const end = skipTo(body, global[0].length + 1, delim);
    return end < 0 ? line : range + body.slice(0, end) + withGdefault(body.slice(end));
  }
  const name = SUBSTITUTE.exec(body);
  if (!name) return line;
  const delim = body[name[0].length];
  const patternEnd = skipTo(body, name[0].length + 1, delim);
  if (patternEnd < 0) return line;
  const replaceEnd = skipTo(body, patternEnd, delim);
  // `:s/a/b` has no flags to flip: add the one gdefault means.
  if (replaceEnd < 0) return `${line}${delim}g`;
  const flags = /^[&cegiInp#lr]*/.exec(body.slice(replaceEnd))![0];
  const rest = body.slice(replaceEnd + flags.length);
  const flipped = flags.includes("g") ? flags.replace(/g/g, "") : flags + "g";
  return range + body.slice(0, replaceEnd) + flipped + rest;
}

const on = () => Vim.getOption("gdefault") === true;

/** The command line to hand the engine now. */
export function gdefaultLine(line: string): string {
  return on() ? withGdefault(line) : line;
}

let installed = false;

/** The option, settable with `:set gd`, and the Vim.handleEx door. */
export function installGdefault(): void {
  if (installed) return;
  installed = true;
  Vim.defineOption("gdefault", false, "boolean", ["gd"]);
  const handleEx = Vim.handleEx;
  Vim.handleEx = function (cm, input) {
    return handleEx.call(Vim, cm, gdefaultLine(input));
  };
}
