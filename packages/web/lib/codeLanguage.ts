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
