// Which language a file is, and its CodeMirror support, loaded on first use.
//
// @codemirror/language-data is a list of descriptions whose parsers each sit
// behind a dynamic import, so the editor chunk carries the table and a parser
// arrives only when a file of its language opens (contract 3). A description
// caches its own loaded support, so the second file of a language is instant.

import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { registerCodeLanguage } from "./theme";

/** A legacy-modes parser. That package types its parsers against
 *  @codemirror/streamparser, whose StringStream repeats @codemirror/language's
 *  class declaration: the same object at runtime, two types to the checker. */
type LegacyParser = typeof import("@codemirror/legacy-modes/mode/shell").shell;

function stream(parser: LegacyParser): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser as unknown as StreamParser<unknown>));
}
const shell = () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell));
/** A language the shared table already loads, for extra file names. */
const fromTable = (name: string) => () => languages.find((d) => d.name === name)!.load();

/** Files the shared table misses that a repo is full of. Checked first. */
const EXTRA_LANGUAGES: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "Makefile",
    extensions: ["mk", "mak"],
    filename: /^(GNUmakefile|[Mm]akefile)$/,
    // legacy-modes has no make grammar; shell reads recipes and $(VARS) well.
    load: shell,
  }),
  LanguageDescription.of({
    name: "Dotenv",
    filename: /^\.env(\..+)?$|^\.(npmrc|editorconfig|flowconfig)$/,
    load: () => import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  }),
  LanguageDescription.of({
    name: "Shell",
    extensions: ["zsh", "fish", "command"],
    filename: /^\.(bash|zsh)(rc|_profile|env)$|^\.(profile|zprofile|bash_aliases)$|^[Jj]ustfile$|^\.[a-z]+ignore$|^CODEOWNERS$/,
    load: shell,
  }),
  LanguageDescription.of({
    name: "Vim Script",
    extensions: ["vim"],
    filename: /^[._]?g?vimrc$|^\.?exrc$/,
    load: () => import("./vimscriptMode").then((m) => new LanguageSupport(StreamLanguage.define(m.vimscript))),
  }),
  LanguageDescription.of({
    name: "JSON",
    extensions: ["jsonc", "json5", "code-workspace"],
    filename: /^\.(babelrc|eslintrc|prettierrc|swcrc)$/,
    load: fromTable("JSON"),
  }),
  LanguageDescription.of({
    name: "Markdown",
    extensions: ["mdx"],
    load: fromTable("Markdown"),
  }),
];

/** Interpreters a `#!` line names, to the language they run. */
const SHEBANG_LANGUAGES: Record<string, string> = {
  sh: "Shell", bash: "Shell", zsh: "Shell", dash: "Shell", ksh: "Shell", fish: "Shell",
  node: "JavaScript", deno: "TypeScript", bun: "TypeScript", "ts-node": "TypeScript", tsx: "TypeScript",
  python: "Python", python3: "Python", python2: "Python",
  ruby: "Ruby", perl: "Perl", php: "PHP", lua: "Lua", Rscript: "R",
};

/** A language by its display name (EditorFeatureContext.languageName). */
export function languageByName(name: string | null | undefined): LanguageDescription | null {
  if (!name) return null;
  return EXTRA_LANGUAGES.find((d) => d.name === name) ?? languages.find((d) => d.name === name) ?? null;
}

/** The interpreter of a `#!/usr/bin/env -S bun run` style first line. */
function shebangLanguage(firstLine: string): LanguageDescription | null {
  const m = /^#!\s*(\S+)(.*)$/.exec(firstLine);
  if (!m) return null;
  let program = m[1].split("/").pop() ?? "";
  if (program === "env") {
    program = m[2].trim().split(/\s+/).find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "";
  }
  const name = SHEBANG_LANGUAGES[program] ?? SHEBANG_LANGUAGES[program.replace(/[\d.]+$/, "")];
  return languageByName(name);
}

/** The language of a file by its name, else by its `#!` line; null for plain text. */
export function describeLanguage(path: string, firstLine = ""): LanguageDescription | null {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return (
    LanguageDescription.matchFilename(EXTRA_LANGUAGES, filename) ??
    LanguageDescription.matchFilename(languages, filename) ??
    shebangLanguage(firstLine)
  );
}

function registered(desc: LanguageDescription, support: LanguageSupport): LanguageSupport {
  registerCodeLanguage(desc.name, support.language);
  return support;
}

/** The language's support when it has already loaded, else null. */
export function loadedLanguage(desc: LanguageDescription | null): LanguageSupport | null {
  return desc?.support ? registered(desc, desc.support) : null;
}

/** The language's CodeMirror support, loaded once per language. */
export async function loadLanguage(desc: LanguageDescription | null): Promise<LanguageSupport | null> {
  if (!desc) return null;
  try {
    return registered(desc, desc.support ?? (await desc.load()));
  } catch {
    // A parser chunk that fails to load leaves the file readable as plain text.
    return null;
  }
}

/** Language-data names whose LSP id is not simply the name lowercased. */
const LSP_IDS: Record<string, string> = {
  TSX: "typescriptreact",
  JSX: "javascriptreact",
  "C++": "cpp",
  "C#": "csharp",
  "Objective-C": "objective-c",
  "Objective-C++": "objective-cpp",
  Shell: "shellscript",
  "Properties files": "properties",
  Dotenv: "dotenv",
  "F#": "fsharp",
  "VB.NET": "vb",
  "MS SQL": "sql",
  "MySQL": "sql",
  PostgreSQL: "sql",
  SQLite: "sql",
  "MariaDB SQL": "sql",
  PLSQL: "sql",
  LaTeX: "latex",
  sTeX: "tex",
};

/** The LSP `languageId` for a language (as servers and LspServerInfo.languages name it). */
export function lspLanguageId(desc: LanguageDescription | null): string {
  if (!desc) return "plaintext";
  return LSP_IDS[desc.name] ?? desc.name.toLowerCase().replace(/\s+/g, "");
}
