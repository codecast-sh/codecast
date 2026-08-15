// Reading a JSON file you are about to write back.
//
// Several stores here follow the same three steps: read the whole file, change
// one entry, write the whole file back. `cc-accounts.json` and
// `codex-accounts.json` do it on every profile save; `provider-keys.json` does
// it on every `cast keys set`. For that shape a read that fails "quietly" is the
// most destructive thing the code can do — returning an empty value does not
// degrade the next write, it makes the next write a wipe of every entry the
// caller did not touch.
//
// So a reader feeding an update has to answer a question a plain reader never
// has to: is this file EMPTY, or is it merely UNREADABLE? Absent is empty and
// safe to overwrite. Anything else — no permission, corrupt bytes, a truncated
// file, JSON of the wrong shape — is a file whose contents we do not know, and
// the only safe move is to refuse and keep it.
//
// This is deliberately NOT the rule for a read that only feeds a launch or a
// status line. There, degrading to "nothing managed" is correct and throwing
// would break a session over a file that is merely cosmetic. The distinction is
// what the caller does next, which is why it lives in the reader's name.

import * as fs from "fs";

/**
 * Read and parse a JSON file whose contents are about to be rewritten.
 *
 * Returns `undefined` when there is nothing to preserve — the file does not
 * exist, or holds zero bytes because something already truncated it. Throws for
 * every other failure, via `wrapError` so the caller keeps its own error class.
 *
 * `isValid` decides whether the parsed value is the document this store expects.
 * It runs inside the guard on purpose: a file holding valid JSON of the wrong
 * shape is exactly as unknown as one holding no JSON at all.
 */
export function readJsonForUpdate<T>(
  filePath: string,
  wrapError: (message: string) => Error,
  isValid: (parsed: unknown) => boolean,
  expected: string,
): T | undefined {
  const refuse = (why: string, fix: string): never => {
    throw wrapError(
      `${filePath} ${why} — refusing to continue, because writing it now would ` +
        `overwrite everything already in it. ${fix}`,
    );
  };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    refuse(`cannot be read (${code})`, "Fix the file's permissions, then re-run the command.");
  }

  if (raw!.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    refuse(
      "is not valid JSON",
      "Another process may have been mid-write: re-run the command, and if it " +
        "fails again repair or move the file.",
    );
  }

  if (!isValid(parsed)) {
    refuse(`is not ${expected}`, "Repair or move the file, then re-run the command.");
  }
  return parsed as T;
}

export interface ProfileIndexFile<TMeta> {
  profiles: Record<string, TMeta>;
}

/**
 * Read an account index, or throw if it exists and cannot be trusted.
 *
 * The index is the only record that a profile exists — nothing rebuilds it by
 * enumerating the keychain or the profile directories — so losing it strands
 * the credentials on the machine with no way left to list or switch to them.
 */
export function readProfileIndexFile<TMeta>(
  filePath: string,
  wrapError: (message: string) => Error,
): ProfileIndexFile<TMeta> {
  const index = readJsonForUpdate<ProfileIndexFile<TMeta>>(
    filePath,
    wrapError,
    (parsed) =>
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as ProfileIndexFile<TMeta>).profiles === "object" &&
      (parsed as ProfileIndexFile<TMeta>).profiles !== null,
    "a profile index",
  );
  return index ?? { profiles: {} };
}
