// Vim key notation, normalized to the strings codemirror-vim matches on.
//
// The engine names a keypress the way `Vim.vimKeyFromEvent` does: a printable
// character as itself, anything else as `<Mods-Name>` with modifiers in the
// order C- A- M- S-, where M- is the Command key and A- is Alt/Option. Vim's
// own <M-x> means Alt, and MacVim's <D-x> means Command, so both are renamed.

const NAMED: Record<string, string> = {
  cr: "CR",
  return: "CR",
  enter: "CR",
  esc: "Esc",
  tab: "Tab",
  bs: "BS",
  backspace: "BS",
  del: "Del",
  delete: "Del",
  ins: "Ins",
  insert: "Ins",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  kenter: "CR",
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = `F${i}`;

/** Names that stand for a literal character. */
const LITERAL: Record<string, string> = { bar: "|", bslash: "\\", lt: "<" };

/** Control characters typed into a vimrc with Ctrl-V. */
function controlChar(code: number): string {
  if (code === 27) return "<Esc>";
  if (code === 13) return "<CR>";
  if (code === 9) return "<Tab>";
  return `<C-${String.fromCharCode(code + 96)}>`;
}

export type KeyToken =
  | { kind: "key"; keys: string }
  | { kind: "leader"; local: boolean }
  | { kind: "plug"; name: string }
  | { kind: "cmd" }
  | { kind: "nop" }
  | { kind: "unsupported"; name: string };

const NOTATION = /^<([^<>\s]+)>/;

function namedKey(body: string): KeyToken | null {
  const lower = body.toLowerCase();
  if (lower === "leader") return { kind: "leader", local: false };
  if (lower === "localleader") return { kind: "leader", local: true };
  if (lower === "nop") return { kind: "nop" };
  if (lower === "cmd" || lower === "scriptcmd") return { kind: "cmd" };
  if (lower === "sid" || lower === "snr" || lower.endsWith("mouse") || lower.startsWith("scroll") || lower === "ignore") {
    return { kind: "unsupported", name: `<${body}>` };
  }
  if (LITERAL[lower]) return { kind: "key", keys: LITERAL[lower] };
  if (lower === "nl") return { kind: "key", keys: "<C-j>" };
  const char = /^char-(0x[0-9a-f]+|\d+)$/i.exec(body);
  if (char) return { kind: "key", keys: String.fromCodePoint(Number(char[1])) };

  const mod = /^((?:[CSAMDT]-)+)(.+)$/i.exec(body);
  const mods = new Set<string>();
  let key = body;
  if (mod) {
    for (const m of mod[1].toUpperCase().split("-")) if (m) mods.add(m);
    key = mod[2];
  }
  let name: string;
  if (key.length === 1) {
    name = key;
  } else if (NAMED[key.toLowerCase()]) {
    name = NAMED[key.toLowerCase()];
  } else if (LITERAL[key.toLowerCase()]) {
    name = LITERAL[key.toLowerCase()];
  } else {
    return null;
  }
  if (mods.size === 0) return { kind: "key", keys: name.length === 1 ? name : `<${name}>` };

  const ctrl = mods.has("C");
  const alt = mods.has("A") || mods.has("M");
  const cmd = mods.has("D") || mods.has("T");
  let shift = mods.has("S");
  if (name.length === 1 && /[a-z]/i.test(name)) {
    // Vim reads <C-X> as <C-x>; the engine spells Shift as an uppercase letter.
    name = shift ? name.toUpperCase() : name.toLowerCase();
    if (!ctrl && !alt && !cmd) return { kind: "key", keys: name };
  } else if (name.length === 1 && shift && !ctrl && !alt && !cmd) {
    shift = false;
  }
  const prefix = `${ctrl ? "C-" : ""}${alt ? "A-" : ""}${cmd ? "M-" : ""}${shift && (name.length > 1 || ctrl || alt || cmd) ? "S-" : ""}`;
  return { kind: "key", keys: prefix ? `<${prefix}${name}>` : name };
}

/** Split a key sequence written in vim notation into tokens. Unknown `<...>`
 *  groups read as the literal characters they are, as in vim. */
export function tokenizeKeys(raw: string): KeyToken[] {
  const out: KeyToken[] = [];
  let i = 0;
  while (i < raw.length) {
    const rest = raw.slice(i);
    const m = NOTATION.exec(rest);
    if (m) {
      if (m[1].toLowerCase() === "plug") {
        const name = /^(\([^)]*\)|[\w#.:-]+)/.exec(rest.slice(m[0].length));
        out.push({ kind: "plug", name: name ? name[1] : "" });
        i += m[0].length + (name ? name[1].length : 0);
        continue;
      }
      const tok = namedKey(m[1]);
      if (tok) {
        out.push(tok);
        i += m[0].length;
        continue;
      }
    }
    const cp = raw.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (cp < 32) out.push({ kind: "key", keys: controlChar(cp) });
    else out.push({ kind: "key", keys: ch });
    i += ch.length;
  }
  return out;
}

/** The engine splits key strings with this; one match is one keypress. */
export const ENGINE_KEY = /<(?:[CSMA]-)*\w+>|[\s\S]/gu;

export function splitEngineKeys(keys: string): string[] {
  return keys.match(ENGINE_KEY) ?? [];
}

/** Keys as typed on the left side of a map: a literal space is the <Space>
 *  key the engine reports for the space bar. */
export function lhsKeys(keys: string): string {
  return keys.replace(/ /g, "<Space>");
}

/** Evaluate a vimscript string literal ("..." or '...'). Key escapes like
 *  "\<Space>" stay in key notation so they can be used as keys. */
export function vimStringValue(literal: string): string | null {
  const s = literal.trim();
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    const body = s.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== "\\" || i === body.length - 1) {
        out += c;
        continue;
      }
      const n = body[++i];
      if (n === "<") {
        const end = body.indexOf(">", i);
        if (end > 0) {
          out += body.slice(i, end + 1);
          i = end;
          continue;
        }
      }
      out += n === "t" ? "\t" : n === "n" ? "\n" : n === "e" ? "<Esc>" : n;
    }
    return out;
  }
  return null;
}
