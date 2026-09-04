// Prism setup in ONE place: which grammars are loaded, how a fence label or a
// filename maps to one, and how a string gets highlighted.
//
// CodeBlock owned all of this and four other components carried their own
// near-copies of the extension→language table (ConversationView, FileDiffLayout,
// InlineDiff, SharedMessageClient). Those are still to be migrated; nothing new
// should add a sixth.

import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-go";
import "prismjs/components/prism-swift";

/** Fence labels people write that aren't Prism's own grammar name. */
export const LANG_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", sh: "bash", shell: "bash", zsh: "bash",
  yml: "yaml", md: "markdown", html: "markup", xml: "markup",
};

/** Filename extension → grammar. Only entries whose grammar is actually loaded
 *  above earn a place; anything else renders as plain text, which is honest and
 *  still perfectly readable. */
const EXT_LANGUAGES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", swift: "swift",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  css: "css", scss: "css", sass: "css", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff",
};

/** Extensionless filenames whose content has a grammar we load. */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "bash", makefile: "bash", justfile: "bash",
  procfile: "bash", brewfile: "bash", gemfile: "bash", rakefile: "bash",
};

/** Grammar for a file path, or undefined when we have none — the viewer then
 *  shows the text unstyled rather than guessing. */
export function languageForPath(filePath: string): string | undefined {
  const name = (filePath.split("/").pop() ?? "").toLowerCase();
  const byName = FILENAME_LANGUAGES[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  // A leading-dot name (".gitignore") has no extension — the whole name is it.
  if (dot <= 0) return undefined;
  return EXT_LANGUAGES[name.slice(dot + 1)];
}

/** Highlighted HTML, or null when there is no grammar for this language (the
 *  caller must then render the raw text — never inject null as markup). */
export function highlightCode(code: string, language?: string): string | null {
  if (!language) return null;
  const lang = LANG_ALIASES[language] || language;
  const grammar = Prism.languages[lang];
  if (!grammar) return null;
  try {
    return Prism.highlight(code, grammar, lang);
  } catch {
    return null;
  }
}

/**
 * The same highlighting, split into one HTML string per source line.
 *
 * A file viewer needs each line as its own element: a line number beside it, a
 * comment thread under it, a blame note in front of it. Prism highlights the
 * whole file at once, and a token can cross a newline (a block comment, a
 * template string), so the split re-closes every open span at the end of a line
 * and re-opens it at the start of the next. Highlighting per line instead would
 * mis-colour everything after the first `/*`.
 *
 * Returns null when there is no grammar, exactly as highlightCode does.
 */
export function highlightLines(code: string, language?: string): string[] | null {
  const html = highlightCode(code, language);
  return html === null ? null : splitHighlightedLines(html);
}

/** Split highlighted HTML on newlines, keeping every span balanced per line. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let i = 0;

  const closeAll = () => "</span>".repeat(open.length);

  while (i < html.length) {
    const nextTag = html.indexOf("<", i);
    const nextBreak = html.indexOf("\n", i);
    // Whichever comes first; -1 means "not in the rest of the string".
    const stop =
      nextTag === -1 ? nextBreak : nextBreak === -1 ? nextTag : Math.min(nextTag, nextBreak);

    if (stop === -1) {
      current += html.slice(i);
      break;
    }
    current += html.slice(i, stop);

    if (stop === nextBreak) {
      lines.push(current + closeAll());
      current = open.join("");
      i = stop + 1;
      continue;
    }

    const end = html.indexOf(">", stop);
    if (end === -1) {
      current += html.slice(stop);
      break;
    }
    const tag = html.slice(stop, end + 1);
    if (tag.startsWith("</")) open.pop();
    else if (!tag.endsWith("/>")) open.push(tag);
    current += tag;
    i = end + 1;
  }

  lines.push(current + closeAll());
  return lines;
}
