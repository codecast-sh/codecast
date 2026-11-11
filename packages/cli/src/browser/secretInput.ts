/**
 * `cast browser type|fill <target> --vault <name>[/field]` and `--stdin`: a
 * value that must never be an argument goes into a field.
 *
 * The plain form hands its text to the engine as an argument, where `ps`
 * shows it and the transcript keeps the command line. These two forms never
 * reach the engine: the value goes from the Vault (typeSecret, with its Sites
 * and origin checks) or from stdin straight into CDP `Input.insertText` on
 * the session's tab, and the command reports what it typed by name only.
 *
 * Every flag type and fill take is listed here; any other `--flag` is an
 * error, because the engine would otherwise type it into the field as text.
 * `--` ends the flags, for text that starts with two dashes.
 */

import * as fs from "node:fs";
import type { PublishDeps } from "../castApi.js";
import { fmt, icons } from "../colors.js";
import { loadSitePolicy, type SitePolicy } from "./policy.js";
import type { PageCtx } from "./pageEval.js";
import { engineTabFor } from "./sessionTab.js";
import {
  SECRET_TYPE_FIELDS,
  SecretTypeRefusal,
  secretPageFor,
  typeSecret,
  typeText,
  typedLine,
  vaultReads,
  type SecretTypeDeps,
  type SecretTypeField,
  type SecretTypePage,
} from "./secretType.js";

/** Flags type and fill pass on when they type text the agent wrote. */
const TEXT_FLAGS = new Set(["--submit", "--no-shot", "--no-capture", "--json"]);

export interface SecretInput {
  mode: "vault" | "stdin";
  target: string;
  /** The Vault entry, for --vault. */
  name?: string;
  /** Which of its values; unset means the kind's default (a login's password). */
  field?: SecretTypeField;
  submit: boolean;
  json: boolean;
  /** --no-shot / --no-capture, for the Enter that --submit presses. */
  stepFlags: string[];
}

export type TypeArgs =
  | { mode: "text"; args: string[] }
  | SecretInput
  | { error: string; hint: string };

const usage = (verb: string) =>
  `cast browser ${verb} <target> <text>, or --vault <name>[/username|/password|/otp] or --stdin in place of the text`;

/** `name` or `name/field` → the entry and the field it names. */
export function parseVaultSpec(spec: string): { name: string; field?: SecretTypeField } | { error: string } {
  const slash = spec.indexOf("/");
  const name = slash < 0 ? spec : spec.slice(0, slash);
  const field = slash < 0 ? undefined : spec.slice(slash + 1);
  if (!name) return { error: "--vault needs a secret name: --vault <name>[/field]" };
  if (field !== undefined && !(SECRET_TYPE_FIELDS as readonly string[]).includes(field)) {
    return { error: `--vault ${spec}: the field after / is one of ${SECRET_TYPE_FIELDS.join(", ")}` };
  }
  return { name, field: field as SecretTypeField | undefined };
}

/**
 * The arguments of `type` or `fill` (after the browser-choice flags are
 * split off), checked. `lastFind` is the ref a bare action falls back to.
 * Pure: it reads nothing and prints nothing.
 */
export function parseTypeArgs(verb: string, args: string[], lastFind: string | null = null): TypeArgs {
  const positional: string[] = [];
  const flags: string[] = [];
  let vault: string | undefined;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (a === "--vault" || a.startsWith("--vault=")) {
      const v = a === "--vault" ? args[++i] : a.slice("--vault=".length);
      if (!v || v.startsWith("--")) return { error: "--vault needs a secret name: --vault <name>[/field]", hint: usage(verb) };
      vault = v;
    } else if (a === "--stdin") {
      stdin = true;
    } else if (TEXT_FLAGS.has(a)) {
      flags.push(a);
    } else {
      return {
        error: `${verb} does not take ${a.split("=")[0]}`,
        hint: `Its flags: ${[...TEXT_FLAGS, "--vault <name>[/field]", "--stdin"].join(", ")}. Text that starts with -- goes after a bare --.`,
      };
    }
  }
  if (!vault && !stdin) return { mode: "text", args };
  if (vault && stdin) return { error: `${verb} takes --vault or --stdin, not both`, hint: usage(verb) };
  const how = vault ? "--vault" : "--stdin";
  if (positional.length > 1) {
    return { error: `${verb} ${how} takes only the target: the value comes from ${vault ? "the Vault" : "stdin"}, never an argument`, hint: usage(verb) };
  }
  const target = positional[0] ?? lastFind;
  if (!target) return { error: `${verb} ${how} needs a target`, hint: "a #e12 ref from `cast browser snapshot -i`, or a CSS selector" };
  const base = { target, submit: flags.includes("--submit"), json: flags.includes("--json"), stepFlags: flags.filter((f) => f === "--no-shot" || f === "--no-capture") };
  if (!vault) return { mode: "stdin", ...base };
  const spec = parseVaultSpec(vault);
  if ("error" in spec) return { error: spec.error, hint: usage(verb) };
  return { mode: "vault", ...base, name: spec.name, field: spec.field };
}

/** stdin as the value: one trailing newline (from a pipe or heredoc) is not part of it. */
export function stdinValue(read: () => string = () => fs.readFileSync(0, "utf-8")): string {
  if (process.stdin.isTTY) throw new SecretTypeRefusal("--stdin reads the value from a pipe", "cast vault get <name> | cast browser fill <target> --stdin, or use --vault <name>");
  const text = read().replace(/\r?\n$/, "");
  if (!text) throw new SecretTypeRefusal("stdin was empty");
  return text;
}

/**
 * Type a --vault or --stdin value (`text`, already read) into `page`. Returns
 * the line to print, which names the source and never holds the value.
 * `fill` replaces what the field holds, `type` inserts at the caret.
 */
export async function typeSecretInput(
  verb: string,
  input: SecretInput,
  env: { page: SecretTypePage; vault: Pick<SecretTypeDeps, "meta" | "read">; policy: SitePolicy | null; text?: string },
): Promise<string> {
  const append = verb === "type";
  if (input.mode === "stdin") {
    const res = await typeText(env.text ?? "", { append }, env.page);
    return input.json ? JSON.stringify({ typed: true, source: "stdin", origin: res.origin }) : `${fmt.success(icons.check)} typed the value from stdin on ${res.origin}`;
  }
  const res = await typeSecret(input.name!, { field: input.field, append }, { ...env.vault, policy: env.policy, page: env.page });
  return input.json ? JSON.stringify(res) : typedLine(res);
}

/** typeSecretInput on this session's tab, with this session's Vault reads. */
export async function runSecretInput(verb: string, input: SecretInput, ctx: PageCtx, deps: PublishDeps): Promise<string> {
  // Read stdin before touching the page: a failed read types nothing.
  const text = input.mode === "stdin" ? stdinValue() : undefined;
  const tab = await engineTabFor(ctx);
  try {
    return await typeSecretInput(verb, input, { page: secretPageFor(tab, input.target), vault: vaultReads(deps), policy: loadSitePolicy(), text });
  } finally {
    tab.conn.close();
  }
}
