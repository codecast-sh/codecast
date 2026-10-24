// `cast vault`'s argv: the words after the group token, the old Files verbs
// that moved to `cast files`, and `run`'s names, flags and command around `--`.
import * as fs from "node:fs";
import * as os from "node:os";
import { SECRET_NAME_RE } from "@codecast/shared/contracts/secrets";
import { shellQuote } from "../shellQuote.js";

const FILES_ONLY_VERBS = new Set(["mirror", "forget", "cat", "read", "grep", "search", "write", "edit", "mv", "links", "open", "rename"]);

const plainWord = (a: string) => /^[\w@%+=:,./~-]+$/.test(a);
const isDirectory = (p: string) => {
  try {
    return fs.statSync(p.replace(/^~(?=$|\/)/, os.homedir())).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `cast vault` used to be the Files CLI. When the words after it are a Files
 * command (a Files-only verb, `add` of a path, `rm` of a note, a bare
 * directory), the same command under `cast files`, else null.
 */
export function filesCommandFor(args: readonly string[], isDir: (p: string) => boolean = isDirectory): string | null {
  const [verb, target] = args;
  if (!verb || verb.startsWith("-")) return null;
  // A word a secret could be named or referred to by (a name, sec-N): the slug shape, not the stricter secretNameProblem.
  const vaultWord = (w: string) => SECRET_NAME_RE.test(w);
  let rewritten: string[] | null = null;
  if (FILES_ONLY_VERBS.has(verb)) rewritten = verb === "read" ? ["cat", ...args.slice(1)] : [...args];
  // A path, not a bad name: `add ZZ_Bad` is a secret name for add to refuse, `add ./notes` the old Files verb.
  // A word a secret can be named (stripe, github) is a secret name even where a directory shares it.
  else if (verb === "add" && target && !target.startsWith("-") && (/[/.~\\]/.test(target) || (!vaultWord(target) && isDir(target)))) rewritten = [...args];
  else if (verb === "rm" && target && !target.startsWith("-") && !vaultWord(target)) rewritten = [...args];
  else if (!vaultWord(verb) && isDir(verb)) rewritten = ["add", ...args];
  return rewritten && `cast files ${rewritten.map((a) => (plainWord(a) ? a : shellQuote(a))).join(" ")}`;
}

/** The words after the group token in a full argv (`cast vault mirror x` → [mirror, x]). */
export function argsAfterGroup(rawArgs: readonly string[]): string[] {
  let at = 2;
  while (rawArgs[at]?.startsWith("-")) at++;
  if (rawArgs[at] === "help") return [];
  return rawArgs.slice(at + 1);
}

/** `run`'s names, its --env-file paths (in order), its --why and command: everything after `run` up to `--`, and after it. */
export function splitRunArgs(rawArgs: readonly string[]): { names: string[]; envFiles: string[]; why?: string; command: string[] } | null {
  const after = argsAfterGroup(rawArgs);
  const at = after.indexOf("run");
  const rest = at >= 0 ? after.slice(at + 1) : [];
  const dash = rest.indexOf("--");
  if (dash < 0) return null;
  const names: string[] = [];
  const envFiles: string[] = [];
  let why: string | undefined;
  for (let i = 0; i < dash; i++) {
    const flag = /^--(env-file|why)(?:=([\s\S]*))?$/.exec(rest[i]!);
    if (!flag) {
      names.push(rest[i]!);
      continue;
    }
    const value = flag[2] ?? (i + 1 < dash ? rest[++i]! : "");
    if (flag[1] === "env-file") envFiles.push(value);
    else why = value;
  }
  return { names, envFiles, ...(why ? { why } : {}), command: rest.slice(dash + 1) };
}
