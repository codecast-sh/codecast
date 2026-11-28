// Project symbols without a language server: a ripgrep query for lines that
// declare a name containing the query (`export async function name`, `class
// Name`, `def name`, `fn name`, `func Name`, `struct Name`), through the
// daemon's /code/search route. Go to symbol in project merges these under the
// server's answer, so it finds code by name across the whole repo, in any
// language, and in the many files no running server has loaded.

import { searchCode } from "../daemonClient";
import { requestEndpointOf, useVaultStore } from "../../../store/vaultStore";
import type { SymbolKindName } from "./symbols";

export interface DeclarationHit {
  name: string;
  kind: SymbolKindName;
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based column of the name. */
  column: number;
}

const KEYWORDS: [string, SymbolKindName][] = [
  ["function", "function"],
  ["def", "function"],
  ["fn", "function"],
  ["func", "function"],
  ["class", "class"],
  ["interface", "interface"],
  ["trait", "interface"],
  ["protocol", "interface"],
  ["type", "type"],
  ["enum", "enum"],
  ["struct", "struct"],
  ["impl", "class"],
  ["module", "module"],
  ["namespace", "module"],
  ["mod", "module"],
  ["const", "constant"],
  ["let", "variable"],
  ["var", "variable"],
];
const KIND = new Map(KEYWORDS);
const KEYWORD_ALT = KEYWORDS.map(([k]) => k).join("|");
const MODIFIERS = "(?:(?:export|default|pub(?:\\([a-z]+\\))?|async|static|public|private|protected|abstract|declare|final|open|data|sealed|unsafe|extern)\\s+)*";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ripgrep pattern (Rust regex) for declarations of names containing
 *  `query`, or null for a query too short to be worth a search. */
export function declarationPattern(query: string): string | null {
  const word = query.trim().replace(/[^\w$]/g, "");
  if (word.length < 2) return null;
  return `^\\s*${MODIFIERS}(?:${KEYWORD_ALT})\\*?\\s+[\\w$]*${escape(word)}[\\w$]*`;
}

const LINE = new RegExp(`^(\\s*${MODIFIERS})(${KEYWORD_ALT})(\\*?\\s+)([\\w$]+)`);

/** The declaration a matched line makes, if its name contains `query`. */
export function parseDeclaration(text: string, query: string): { name: string; kind: SymbolKindName; column: number } | null {
  const m = LINE.exec(text);
  if (!m) return null;
  const name = m[4];
  if (!name.toLowerCase().includes(query.trim().toLowerCase().replace(/[^\w$]/g, ""))) return null;
  return { name, kind: KIND.get(m[2]) ?? "variable", column: m[1].length + m[2].length + m[3].length + 1 };
}

/** Declarations in a vault whose names contain `query`, at most `max`. */
export async function searchDeclarations(vaultId: string, query: string, signal: AbortSignal, max = 200): Promise<DeclarationHit[]> {
  const pattern = declarationPattern(query);
  const ep = requestEndpointOf(useVaultStore.getState());
  if (!pattern || !ep) return [];
  const out: DeclarationHit[] = [];
  for await (const ev of searchCode(ep, vaultId, pattern, { regex: true, max }, signal)) {
    if (ev.type === "error") break;
    if (ev.type !== "file") continue;
    for (const l of ev.lines) {
      const d = parseDeclaration(l.text, query);
      if (d) out.push({ ...d, path: ev.path, line: l.line, column: d.column + (l.offset ?? 0) });
    }
  }
  return out;
}
