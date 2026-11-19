// The environments a product repo declares, in `.codecast/envs.toml` beside
// its line.toml (contracts/envs.ts EnvDeclaration). One loader, read by
// `cast env` and the line's eval station. Unknown keys and unknown command
// placeholders are refused with where they sit, so a typo never runs as a
// different command than the one written.
//
//   [[env]]
//   key = "union/unit-smoke"          # <product>/<name>
//   title = "Pricing unit tests"
//   level = "L0"                      # L0..L5
//   command = "bun run scripts/env-smoke.ts --candidate {candidate} --split {split} --out {out}"
//   splits = ["dev"]                  # dev, held, fresh
//   cost_usd = 0                      # declared cost of one run
//   predicts = "L5:intros_a_week"     # what it predicts, a level above
//   timeout_s = 1800                  # stopped, with its children, past this
//   protects = ["evals/graders/**"]   # its grader, cases and checks: no climb candidate may change them
//   role = "check"                    # a climb never climbs it; Guard refuses a survivor that worsens it
//   direction = "higher"              # a check's good direction (higher, the default, or lower)
//   tolerance = 0.02                  # how far its mean may move the wrong way against the base
//   mde = 0.01                        # the smallest mean change it can detect: a floor under a climb's measured noise
//
// Each placeholder is filled shell-quoted, so write it bare: one inside
// quotes is refused, and one handed to eval or `sh -c` runs as code (that is
// the author's choice). A tree counts as clean by `git status`, which does
// not see ignored files: a runner that reads .env.local or ignored fixtures
// scores whatever those hold.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "./proc.js";
import {
  ENVS_REL_PATH,
  ENV_COMMAND_VARS,
  ENV_LEVELS,
  ENV_LINK_TO_RE,
  ENV_LIMITS,
  ENV_SPLITS,
  isEnvKey,
  isEnvLevel,
  isEnvSplit,
  type EnvDeclaration,
  type EnvSplit,
} from "@codecast/shared/contracts/envs";

export { ENVS_REL_PATH };

export class EnvDeclarationError extends Error {
  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message);
    this.name = "EnvDeclarationError";
  }
}

const ENV_KEYS = ["key", "title", "level", "command", "splits", "cost_usd", "predicts", "timeout_s", "protects", "role", "direction", "tolerance", "mde"] as const;
const isTable = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date);
const text = (x: unknown, where: string): string => {
  if (typeof x !== "string" || !x.trim()) throw new EnvDeclarationError(`${where} must be a non-empty string`);
  return x.trim();
};

/** `{name}` placeholders a command names; `${VAR}` shell expansions are not placeholders. */
export const commandPlaceholders = (command: string): string[] => [...command.matchAll(/(?<!\$)\{([a-z_]+)\}/g)].map((m) => m[1]);

/**
 * Placeholders written inside quotes. Each value is shell-quoted when it is
 * filled, and a quoted value inside double quotes is no longer quoted:
 * `"{candidate}"` with `$(...)` in the candidate runs it.
 */
export function quotedPlaceholders(command: string): string[] {
  const found: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') i++;
      else if (ch === "{" && command[i - 1] !== "$") { const m = command.slice(i).match(/^\{([a-z_]+)\}/); if (m) found.push(m[1]); }
    } else if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') quote = ch;
  }
  return found;
}

/** Parse and check the file's text. */
export function parseEnvsText(source: string, file?: string): EnvDeclaration[] {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(source);
  } catch (err) {
    throw new EnvDeclarationError(`invalid TOML: ${err instanceof Error ? err.message : String(err)}`, file);
  }
  try {
    if (!isTable(raw)) throw new EnvDeclarationError("must be a TOML table");
    const top = Object.keys(raw).filter((k) => k !== "env");
    if (top.length) throw new EnvDeclarationError(`the file has unknown key${top.length > 1 ? "s" : ""} ${top.map((k) => `"${k}"`).join(", ")} (known: [[env]])`);
    if (raw.env === undefined) return [];
    if (!Array.isArray(raw.env)) throw new EnvDeclarationError("[[env]] must be an array of tables");
    const seen = new Set<string>();
    return raw.env.map((e, i) => {
      const where = `[[env]] #${i + 1}`;
      if (!isTable(e)) throw new EnvDeclarationError(`${where} must be a table`);
      const bad = Object.keys(e).filter((k) => !(ENV_KEYS as readonly string[]).includes(k));
      if (bad.length) throw new EnvDeclarationError(`${where} has unknown key${bad.length > 1 ? "s" : ""} ${bad.map((k) => `"${k}"`).join(", ")} (known: ${ENV_KEYS.join(", ")})`);
      const key = text(e.key, `${where} key`);
      if (!isEnvKey(key)) throw new EnvDeclarationError(`${where} key "${key}" must be <product>/<name> (lower case, digits, . _ -)`);
      if (seen.has(key)) throw new EnvDeclarationError(`${key} is declared twice`);
      seen.add(key);
      const at = `[[env]] ${key}`;
      const title = text(e.title, `${at} title`);
      if (title.length > ENV_LIMITS.title_chars) throw new EnvDeclarationError(`${at} title is over ${ENV_LIMITS.title_chars} characters`);
      const level = text(e.level, `${at} level`);
      if (!isEnvLevel(level)) throw new EnvDeclarationError(`${at} level must be one of ${ENV_LEVELS.join(", ")}`);
      const command = text(e.command, `${at} command`);
      const unknown = commandPlaceholders(command).filter((p) => !(ENV_COMMAND_VARS as readonly string[]).includes(p));
      if (unknown.length) throw new EnvDeclarationError(`${at} command names unknown placeholder${unknown.length > 1 ? "s" : ""} ${unknown.map((p) => `{${p}}`).join(", ")} (known: ${ENV_COMMAND_VARS.map((v) => `{${v}}`).join(", ")})`);
      const quoted = quotedPlaceholders(command);
      if (quoted.length) throw new EnvDeclarationError(`${at} command writes ${quoted.map((p) => `{${p}}`).join(", ")} inside quotes; write placeholders bare, each value is quoted for you`);
      const splitsRaw = e.splits === undefined ? ["dev"] : e.splits;
      if (!Array.isArray(splitsRaw) || !splitsRaw.length) throw new EnvDeclarationError(`${at} splits must be a list of ${ENV_SPLITS.join(", ")}`);
      const splits = [...new Set(splitsRaw.map((s, j) => {
        const split = text(s, `${at} splits[${j}]`);
        if (!isEnvSplit(split)) throw new EnvDeclarationError(`${at} splits[${j}] "${split}" must be one of ${ENV_SPLITS.join(", ")}`);
        return split;
      }))] as EnvSplit[];
      const decl: EnvDeclaration = { key, title, level, command, splits };
      if (e.cost_usd !== undefined) {
        if (typeof e.cost_usd !== "number" || !Number.isFinite(e.cost_usd) || e.cost_usd < 0) throw new EnvDeclarationError(`${at} cost_usd must be a number of dollars, 0 or more`);
        decl.cost_usd = e.cost_usd;
      }
      if (e.predicts !== undefined) {
        const predicts = text(e.predicts, `${at} predicts`);
        if (!ENV_LINK_TO_RE.test(predicts)) throw new EnvDeclarationError(`${at} predicts must be <level>:<metric or env key>, like L5:intros_a_week`);
        if (Number(predicts[1]) <= Number(level[1])) throw new EnvDeclarationError(`${at} predicts ${predicts.slice(0, 2)}, which is not above ${level}`);
        decl.predicts = predicts;
      }
      if (e.timeout_s !== undefined) {
        if (typeof e.timeout_s !== "number" || !Number.isInteger(e.timeout_s) || e.timeout_s < 1) throw new EnvDeclarationError(`${at} timeout_s must be a whole number of seconds`);
        decl.timeout_s = e.timeout_s;
      }
      if (e.protects !== undefined) {
        if (!Array.isArray(e.protects) || !e.protects.length) throw new EnvDeclarationError(`${at} protects must be a list of path globs`);
        decl.protects = e.protects.map((g, j) => text(g, `${at} protects[${j}]`));
      }
      if (e.role !== undefined) {
        if (e.role !== "score" && e.role !== "check") throw new EnvDeclarationError(`${at} role must be "score" or "check"`);
        decl.role = e.role;
      }
      if (e.direction !== undefined) {
        if (e.direction !== "higher" && e.direction !== "lower") throw new EnvDeclarationError(`${at} direction must be "higher" or "lower"`);
        if (decl.role !== "check") throw new EnvDeclarationError(`${at} direction applies to a check (role = "check")`);
        decl.direction = e.direction;
      }
      if (e.tolerance !== undefined) {
        if (typeof e.tolerance !== "number" || !Number.isFinite(e.tolerance) || e.tolerance < 0 || e.tolerance > 1) throw new EnvDeclarationError(`${at} tolerance must be a number from 0 to 1 (an absolute change in the mean score)`);
        if (decl.role !== "check") throw new EnvDeclarationError(`${at} tolerance applies to a check (role = "check")`);
        decl.tolerance = e.tolerance;
      }
      if (e.mde !== undefined) {
        if (typeof e.mde !== "number" || !Number.isFinite(e.mde) || e.mde <= 0 || e.mde > 1) throw new EnvDeclarationError(`${at} mde must be a number above 0 and at most 1 (the smallest change in the mean score it can detect)`);
        decl.mde = e.mde;
      }
      return decl;
    });
  } catch (err) {
    if (err instanceof EnvDeclarationError && file && !err.message.startsWith(file)) throw new EnvDeclarationError(err.message, file);
    throw err;
  }
}

/** The repository root holding `cwd`, or null outside one. */
export function repoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The repo's envs: the declarations, the file and the root, or none when the repo has no file. */
export function loadEnvDeclarations(cwd: string): { root: string | null; file: string | null; envs: EnvDeclaration[] } {
  const root = repoRoot(cwd);
  if (!root) return { root: null, file: null, envs: [] };
  const file = path.join(root, ENVS_REL_PATH);
  if (!fs.existsSync(file)) return { root, file: null, envs: [] };
  return { root, file, envs: parseEnvsText(fs.readFileSync(file, "utf8"), file) };
}

const shellQuote = (s: string): string => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command with its placeholders filled, each value shell-quoted. */
export function fillCommand(command: string, vars: Partial<Record<(typeof ENV_COMMAND_VARS)[number], string>>): string {
  return command.replace(/(?<!\$)\{([a-z_]+)\}/g, (whole, name: string) => (vars[name as keyof typeof vars] !== undefined ? shellQuote(vars[name as keyof typeof vars]!) : whole));
}

/** The repo's identity for the registry: its origin remote as host/owner/name, else its directory name. */
export function repoIdentity(root: string): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i);
    if (m) return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  } catch {}
  return path.basename(root);
}

/**
 * A runner's JSON out of what it printed: the whole of stdout when that is
 * one object, else the last whole object among its lines (a runner that
 * logs before or after its result).
 */
export function resultText(stdout: string): string | null {
  const s = stdout.trim();
  if (!s) return null;
  try { JSON.parse(s); return s; } catch {}
  const lines = s.split("\n").slice(-400);
  // The last whole object, wherever its lines start and end (a runner may log after it too).
  for (let end = lines.length; end > 0; end--) {
    if (!lines[end - 1].trimEnd().endsWith("}")) continue;
    for (let start = end - 1; start >= 0; start--) {
      if (!lines[start].trimStart().startsWith("{")) continue;
      const text = lines.slice(start, end).join("\n");
      try { const v = JSON.parse(text); if (v && typeof v === "object" && !Array.isArray(v)) return text; } catch {}
    }
  }
  return null;
}
