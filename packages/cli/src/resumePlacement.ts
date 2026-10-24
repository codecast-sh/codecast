// Where a resumed or freshly delivered session may run on this machine, and
// the words a refusal puts on the conversation. Pure: the daemon supplies the
// resolved checkout and the conversation's recorded project; nothing here
// touches the filesystem, the sync service or tmux.

import * as path from "node:path";
import { isResumableCwd } from "./projectPathResolver.js";

export const UNSAFE_PATH_RE = /[;|&`$(){}<>"\r\n\0]/;

/** What a conversation records about its project (a fetched export, or the
 *  server's project info): enough to place it, and to say whether it names a
 *  repo at all. */
export type ConversationProjectInfo = {
  project_path?: string | null;
  git_root?: string | null;
  git_remote_url?: string | null;
};

// Does the conversation name a project at all? A blank quick-create records
// nothing; anything else — a path, a repo root, a remote — is a repo the
// session must run in, and $HOME is never a substitute for it.
export function conversationNamesRepo(conv: ConversationProjectInfo | null | undefined): boolean {
  return isResumableCwd(conv?.project_path) || !!conv?.git_root?.trim() || !!conv?.git_remote_url?.trim();
}

export type FreshDeliveryPlacement =
  | { kind: "run"; cwd: string }
  | { kind: "refuse"; reason: "no_local_checkout" | "remote_no_project" };

// Where a fresh delivery session (startFreshSessionForDelivery) may run once
// the resolver has spoken. A resolved checkout runs there. A conversation that
// names a repo the resolver could not place is refused — the message stays
// pending and the caller surfaces "clone it first" — rather than running in
// $HOME on whichever machine happened to take the delivery. $HOME is only for
// a conversation with no project at all, and only on a local device; a remote
// box would run it under the wrong identity and context.
export function placeFreshDeliverySession(args: {
  resolvedCwd: string | null;
  conversation: ConversationProjectInfo | null | undefined;
  isRemote: boolean;
  home: string;
}): FreshDeliveryPlacement {
  if (args.resolvedCwd) return { kind: "run", cwd: args.resolvedCwd };
  if (conversationNamesRepo(args.conversation)) return { kind: "refuse", reason: "no_local_checkout" };
  if (args.isRemote) return { kind: "refuse", reason: "remote_no_project" };
  return { kind: "run", cwd: args.home };
}

// "Clone it first" is only an actionable banner when there is a git remote to
// clone. This predicate is consulted ONLY after every resolution attempt has
// already failed (recorded path absent here, no git-remote checkout, and no
// convention/ancestor match via resolveLocalRepo). At that point a recorded path
// alone gives the user nothing to act on — they can't recreate another machine's
// home dir, and "No local checkout for <unknown remote> (recorded path
// /Users/m1/…)" is a dead end. So a foreign path with no remote is suppressed
// (stay silent, clear any stale banner); only a nameable remote earns the banner.
export function noLocalCheckoutBannerActionable(args: {
  remote: string | null | undefined;
  recordedPath?: string | null | undefined;
}): boolean {
  return !!args.remote;
}

// The banner itself, shared by start_session and every resume/delivery refusal.
export function noLocalCheckoutError(remote: string | null | undefined, recordedPath: string | null | undefined): string {
  return `No local checkout for ${remote ?? "<unknown remote>"} (recorded path ${recordedPath ?? "unknown"} doesn't exist here). Clone it first.`;
}

// The start_session banner when the folder is missing and no remote names a
// repo to clone: the session has to start somewhere this machine has.
export function missingFolderError(recordedPath: string): string {
  return `${recordedPath} isn't on this machine. Start the session in a folder this machine has.`;
}

// The same refusal for a session that already ran somewhere else.
export function missingResumeFolderError(recordedPath: string): string {
  return `${recordedPath} isn't on this machine and no repository is recorded to clone. Move the session to a machine that has it.`;
}

// A new session started in a folder that isn't here yet (the new-session
// picker's "create" choice) gets that folder. Only a plain folder inside this
// machine's home: a recorded remote, or a repo root other than the folder
// itself (pickers stamp git_root = the folder on a fresh start), means a
// checkout to clone, not an empty directory to invent; a path outside home
// came from another machine.
export function creatableStartFolder(
  rawPath: string,
  home: string | undefined,
  recorded: { git_root: string | null; git_remote_url: string | null } | null,
): string | null {
  if (!home || !rawPath || !path.isAbsolute(rawPath) || UNSAFE_PATH_RE.test(rawPath)) return null;
  if (recorded?.git_remote_url) return null;
  const resolved = path.resolve(rawPath);
  if (recorded?.git_root && path.resolve(recorded.git_root) !== resolved) return null;
  return resolved.startsWith(path.resolve(home) + path.sep) ? resolved : null;
}
