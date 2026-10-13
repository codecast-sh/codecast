// The instance file (docs/architecture/org-hire.md H2, H3): the hire's answers
// written into the checkout at the path the manifest names, for the release's
// own scripts and skills to read. JSON by default; a `.toml` path is merged
// line by line so sections the role keeps there (ledgers, sessions, notes)
// and the comments beside them survive every rewrite.
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicJson, noSymlink, type OrgTemplate } from "./orgTemplateArtifact.js";

export const DEFAULT_INSTANCE_FILE = (instance: string) => `.codecast/org-templates/${instance}.config.json`;

export function instanceFilePath(dir: string, instance: string, manifest: Pick<OrgTemplate, "instance_file">): string {
  const file = path.join(dir, manifest.instance_file ?? DEFAULT_INSTANCE_FILE(instance));
  if (path.relative(dir, file).startsWith("..")) throw new Error("Instance file must live inside the project");
  noSymlink(file);
  return file;
}

/** `a.b.c=v` answers as a nested object, typed by the manifest's input kinds. */
export function nestedConfig(manifest: Pick<OrgTemplate, "inputs">, config: Record<string, string>): Record<string, unknown> {
  const kinds = new Map((manifest.inputs ?? []).map((i) => [i.key, i.kind]));
  const root: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(config)) {
    const parts = key.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = typedValue(kinds.get(key), raw);
  }
  return root;
}

function typedValue(kind: string | undefined, raw: string): unknown {
  if (kind === "number" || kind === "money") return Number(raw);
  if (kind === "boolean") return raw === "true";
  return raw;
}

function tomlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

/**
 * Merge answers into TOML text. Each answer is `[table]` + `key = value`; a
 * key that exists in its table is rewritten in place (its trailing comment
 * kept), a missing key is appended to the end of its table, a missing table
 * is appended at the end. Nothing else in the file moves.
 */
export function mergeToml(text: string, values: Record<string, unknown>): string {
  const lines = text.length ? text.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const entries: Array<{ table: string; key: string; value: unknown }> = [];
  const walk = (node: Record<string, unknown>, prefix: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && !Array.isArray(value)) walk(value as Record<string, unknown>, [...prefix, key]);
      else entries.push({ table: prefix.join("."), key, value });
    }
  };
  walk(values, []);
  const tableAt = (name: string) => lines.findIndex((l) => l.trim() === `[${name}]`);
  const tableEnd = (start: number) => { let end = start + 1; while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++; while (end > start + 1 && lines[end - 1]!.trim() === "") end--; return end; };
  for (const { table, key, value } of entries) {
    if (!table) throw new Error(`Top level answer ${key} has no table; use a dotted input key`);
    let start = tableAt(table);
    if (start < 0) { if (lines.length && lines[lines.length - 1] !== "") lines.push(""); lines.push(`[${table}]`); start = lines.length - 1; }
    const end = tableEnd(start);
    const pattern = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    const at = lines.slice(start + 1, end).findIndex((l) => pattern.test(l));
    const rendered = `${key} = ${tomlScalar(value)}`;
    if (at >= 0) {
      const line = lines[start + 1 + at]!;
      const comment = trailingComment(line);
      lines[start + 1 + at] = comment ? `${rendered}   ${comment}` : rendered;
    } else lines.splice(end, 0, rendered);
  }
  return lines.join("\n") + "\n";
}

/** The `# …` after a value, outside a string; TOML strings here are JSON-shaped. */
function trailingComment(line: string): string | null {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inString) { i++; continue; }
    if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(i).trim();
  }
  return null;
}

export function writeInstanceFile(dir: string, instance: string, manifest: Pick<OrgTemplate, "inputs" | "instance_file">, config: Record<string, string>): string {
  const file = instanceFilePath(dir, instance, manifest);
  const values = nestedConfig(manifest, config);
  if (file.endsWith(".toml")) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, mergeToml(current, values), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } else {
    const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    atomicJson(file, deepMerge(current, values));
  }
  return file;
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] = value && typeof value === "object" && !Array.isArray(value) && prior && typeof prior === "object" && !Array.isArray(prior)
      ? deepMerge(prior as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}
