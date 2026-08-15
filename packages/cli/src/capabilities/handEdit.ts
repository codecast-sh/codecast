// Hand edits and deliberate deletions of files the reconciler owns.
//
// ownedJson.ts states the five-case model for JSON keys, and its subtle fourth
// rule is the one this module gives to whole markdown regions: once someone
// edits a value it is THEIRS — removing or rewriting it later, because we
// happened to write it first, deletes their work. A reconciler that silently
// reverts a hand edit on the next beat teaches its user to stop editing, and
// then to uninstall.
//
// The mechanism is a three-hash compare per owned file:
//
//   wroteHash    what we last wrote (recorded at apply time)
//   diskHash     what is on disk now
//   desiredHash  what we would write this beat
//
// disk == wrote            → ours, converge freely
// disk == desired          → already right, zero ops
// disk != wrote (edited)   → locally_modified conflict: the user's copy STAYS,
//                            the conflict carries both texts and two explicit
//                            choices — keep the edit (adopt) or restore ours.
// gone, parent dir intact  → recreated at most ONCE, recorded; gone AGAIN →
//                            locally_removed, and we STOP. Anything that
//                            recreates a file a user deleted, twice a minute,
//                            forever, is a bug regardless of what the server
//                            says the desired state is.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface OwnedFileRecord {
  /** Hash of the bytes we last wrote. */
  wroteHash: string;
  /** The file vanished once and we recreated it. Second vanish = theirs. */
  recreatedOnce?: boolean;
  /** The user deleted it twice; the binding holds but we write nothing. */
  locallyRemoved?: boolean;
}

export type HandEditVerdict =
  | { action: "write" }
  | { action: "none" }
  | {
      action: "conflict";
      reason: "locally_modified";
      /** Both texts ride the conflict so the UI can show a diff and offer the
       *  two choices without another disk read. */
      theirs: string;
      ours: string;
    }
  | { action: "recreate"; note: "recreated_once" }
  | { action: "hold"; reason: "locally_removed" };

export function contentHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * Decide what the reconciler may do to one owned file this beat.
 *
 * Pure over (record, disk, desired) — the caller reads the file and persists
 * the record; this function only ever answers, so every branch is testable
 * without a filesystem.
 */
export function judgeOwnedFile(
  record: OwnedFileRecord | undefined,
  disk: string | undefined,
  desired: string,
): HandEditVerdict {
  if (record === undefined) {
    // Not ours yet: a first write, or a file we never owned. The caller only
    // asks about paths it is materializing, so absent record = first install.
    return { action: "write" };
  }

  if (record.locallyRemoved) {
    return { action: "hold", reason: "locally_removed" };
  }

  if (disk === undefined) {
    // Gone. Once is maybe an accident (a stray rm, a bad sync); twice is a
    // decision.
    if (record.recreatedOnce) return { action: "hold", reason: "locally_removed" };
    return { action: "recreate", note: "recreated_once" };
  }

  const diskHash = contentHash(disk);
  if (diskHash === contentHash(desired)) return { action: "none" };
  if (diskHash === record.wroteHash) return { action: "write" };

  // Edited by hand: theirs now.
  return { action: "conflict", reason: "locally_modified", theirs: disk, ours: desired };
}

/**
 * One reconcile step for one owned markdown file, applying the verdict to disk
 * and returning the updated record plus any conflict.
 */
export function reconcileOwnedFile(
  filePath: string,
  record: OwnedFileRecord | undefined,
  desired: string,
  writeFile: (p: string, content: string) => void,
): { record: OwnedFileRecord; conflict?: { reason: string; theirs: string; ours: string } } {
  let disk: string | undefined;
  try {
    disk = fs.readFileSync(filePath, "utf-8");
  } catch {
    disk = undefined;
  }

  // A missing PARENT directory is not a deletion of our file — the whole tree
  // moved or was never there. First-install semantics apply.
  if (disk === undefined && record !== undefined && !fs.existsSync(path.dirname(filePath))) {
    record = undefined;
  }

  const verdict = judgeOwnedFile(record, disk, desired);
  switch (verdict.action) {
    case "write": {
      writeFile(filePath, desired);
      return { record: { wroteHash: contentHash(desired), recreatedOnce: record?.recreatedOnce } };
    }
    case "recreate": {
      writeFile(filePath, desired);
      return { record: { wroteHash: contentHash(desired), recreatedOnce: true } };
    }
    case "none":
      return { record: record! };
    case "hold":
      return { record: { ...record!, locallyRemoved: true } };
    case "conflict":
      return {
        record: record!,
        conflict: { reason: verdict.reason, theirs: verdict.theirs, ours: verdict.ours },
      };
  }
}
