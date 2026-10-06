// The builder's working copy: the base version's files in memory, the file
// operations its tools perform, and the checks a draft must pass before it
// can become a version. The checks go past what the version writer enforces
// (lib/files + lib/transpile) to what makes an app break at load in the
// browser: an import of a file that is not there, a package the import map
// does not name, a stylesheet imported from JavaScript.
import { ENTRY_PATH, byteLength, fileExtension, fileSetProblems, needsTranspile, normalizeFilePath, type FileDraft } from "../lib/files";
import { esmUrl } from "../lib/runtime";
import { transpile } from "../lib/transpile";
import type { TouchedFile } from "../validators";

const ALLOWED_TYPES = ".html .js .mjs .jsx .ts .tsx .css .json .svg .txt .md";

/** A file operation the agent got wrong; its message goes back to the agent. */
export class DraftError extends Error {}

function canonical(raw: string): string {
  return normalizeFilePath(raw) ?? fail(`"${raw}" is not a path a version can hold. Use a relative path like src/App.jsx with one of: ${ALLOWED_TYPES}.`);
}

function fail(message: string): never {
  throw new DraftError(message);
}

export class Draft {
  private readonly files: Map<string, string>;
  private readonly base: Map<string, string>;
  private readonly reads = new Set<string>();

  constructor(files: readonly FileDraft[]) {
    this.base = new Map(files.map((f) => [f.path, f.text]));
    this.files = new Map(this.base);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Every file with its size, one per line. */
  list(): string {
    return this.paths()
      .map((p) => `${p} (${byteLength(this.files.get(p)!)} bytes)`)
      .join("\n");
  }

  read(raw: string): string {
    const path = canonical(raw);
    const text = this.files.get(path) ?? fail(`${path} does not exist. Files: ${this.paths().join(", ")}`);
    this.reads.add(path);
    return text;
  }

  write(raw: string, text: string): string {
    const path = canonical(raw);
    const existed = this.files.has(path);
    this.files.set(path, text);
    return `${existed ? "Rewrote" : "Created"} ${path} (${byteLength(text)} bytes).`;
  }

  /** Replace exactly one occurrence of `find` (or every one, with `all`). */
  edit(raw: string, find: string, replace: string, all = false): string {
    const path = canonical(raw);
    const text = this.files.get(path) ?? fail(`${path} does not exist. Create it with write_file.`);
    if (!find) fail("old_text is empty. Give the exact text to replace.");
    const count = text.split(find).length - 1;
    if (count === 0) fail(`old_text was not found in ${path}. Read the file and copy the text exactly, whitespace included.`);
    if (count > 1 && !all) fail(`old_text appears ${count} times in ${path}. Include more surrounding lines so it is unique, or set all to true.`);
    this.files.set(path, all ? text.split(find).join(replace) : text.replace(find, () => replace));
    return `Edited ${path}${count > 1 ? ` (${count} places)` : ""}.`;
  }

  remove(raw: string): string {
    const path = canonical(raw);
    if (path === ENTRY_PATH) fail(`${ENTRY_PATH} is the app's entry and cannot be deleted.`);
    if (!this.files.delete(path)) fail(`${path} does not exist.`);
    return `Deleted ${path}.`;
  }

  /** Every file now, sorted by path. */
  snapshot(): FileDraft[] {
    return this.paths().map((path) => ({ path, text: this.files.get(path)! }));
  }

  /** What the build has touched so far, as its card shows it: changed files
   *  first, then files it only read. */
  touched(): TouchedFile[] {
    const out: TouchedFile[] = [];
    for (const path of new Set([...this.base.keys(), ...this.files.keys()])) {
      const before = this.base.get(path);
      const after = this.files.get(path);
      if (after === undefined) out.push({ path, how: "deleted" });
      else if (after !== before) out.push({ path, how: "wrote" });
    }
    const changed = new Set(out.map((t) => t.path));
    for (const path of this.reads) if (!changed.has(path)) out.push({ path, how: "read" });
    return out;
  }

  changed(): boolean {
    return this.touched().some((t) => t.how !== "read");
  }
}

// ------------------------------------------------------------- validation

const MODULE_TYPES = new Set(["js", "mjs", "jsx", "ts", "tsx"]);

/** Specifiers a module imports: static, side effect, re-export and dynamic. */
export function importSpecifiers(code: string): string[] {
  const body = code
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const patterns = [
    /\b(?:import|export)\s+[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((re) => [...body.matchAll(re)].map((m) => m[1]));
}

/** The import map's keys from index.html, or an error when it is unreadable. */
export function importMapKeys(html: string): { keys: string[] } | { error: string } {
  const m = /<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return { keys: [] };
  try {
    const map = JSON.parse(m[1]) as { imports?: Record<string, string> };
    return { keys: Object.keys(map.imports ?? {}) };
  } catch (e) {
    return { error: `the import map in ${ENTRY_PATH} is not valid JSON (${e instanceof Error ? e.message : e})` };
  }
}

function isUrl(spec: string): boolean {
  return /^(https?:|data:|blob:)/i.test(spec);
}

/** A relative reference resolved against the file that makes it; null when it climbs out of the app. */
export function resolveRelative(from: string, spec: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split(/[?#]/)[0].split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function mapped(spec: string, keys: string[]): boolean {
  return keys.some((k) => k === spec || (k.endsWith("/") && spec.startsWith(k)));
}

function moduleProblems(path: string, code: string, has: (p: string) => boolean, mapKeys: string[]): string[] {
  const problems: string[] = [];
  for (const spec of new Set(importSpecifiers(code))) {
    if (isUrl(spec)) continue;
    if (spec.startsWith("/")) {
      problems.push(`${path} imports "${spec}"; use a relative path ("./...") so it resolves inside the app's folder`);
      continue;
    }
    if (spec.startsWith(".")) {
      const target = resolveRelative(path, spec);
      if (!target || !has(target)) {
        problems.push(`${path} imports "${spec}", but ${target ?? spec} does not exist`);
      } else if (fileExtension(target) === "css") {
        problems.push(`${path} imports the stylesheet "${spec}"; browsers cannot import CSS from JavaScript, so link it from ${ENTRY_PATH} instead`);
      } else if (!MODULE_TYPES.has(fileExtension(target))) {
        problems.push(`${path} imports "${spec}", which is not a JavaScript module; fetch it at runtime or inline it`);
      }
      continue;
    }
    if (!mapped(spec, mapKeys)) {
      problems.push(`${path} imports "${spec}", which the import map does not name; import "${esmUrl(`${spec}@<version>`)}" instead`);
    }
  }
  return problems;
}

/** Local files index.html loads with <script src> and <link href>. */
export function htmlReferences(html: string): string[] {
  const refs = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi),
  ].map((m) => m[1]);
  return refs.filter((r) => !isUrl(r) && !r.startsWith("#") && !r.startsWith("//"));
}

/** Every reason this draft cannot go live, in words the agent can act on.
 *  Empty when it can. */
export function draftProblems(files: readonly FileDraft[]): string[] {
  const problems = [...fileSetProblems(files)];
  const has = (p: string) => files.some((f) => f.path === p);
  const entry = files.find((f) => f.path === ENTRY_PATH);
  const map = entry ? importMapKeys(entry.text) : { keys: [] };
  if ("error" in map) problems.push(map.error);
  const keys = "keys" in map ? map.keys : [];

  for (const f of files) {
    const ext = fileExtension(f.path);
    if (!MODULE_TYPES.has(ext)) continue;
    let code = f.text;
    if (needsTranspile(f.path)) {
      const out = transpile(f.path, f.text);
      if (!out.ok) {
        problems.push(out.error);
        continue;
      }
      code = out.code;
    }
    problems.push(...moduleProblems(f.path, code, has, keys));
  }

  if (entry) {
    for (const ref of htmlReferences(entry.text)) {
      if (ref.startsWith("/")) problems.push(`${ENTRY_PATH} loads "${ref}"; use a relative path like "src/main.jsx"`);
      else if (!has(resolveRelative(ENTRY_PATH, ref) ?? "")) problems.push(`${ENTRY_PATH} loads "${ref}", which does not exist`);
    }
  }
  return problems;
}
