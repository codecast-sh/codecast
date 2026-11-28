// A merge step's switch being off, in one set of words every reader matches,
// and the change flow's ending for it: a role's hand whose role keeps its
// merge off (a Release Captain's, by design) hands the change to the role
// (change.cast `handed`), which merges it itself.
//
// The words: the server's refusal (convex lib/lineMerge.ts mergeAllowance) is
// "@<handle>'s merge is off: …" for a role, else "merge is off for this flow;
// …". A change run's stop carries it after "Stopped: ", the line flow's merge
// after "merge left to a person: ", and its ship step after "not merged: ".

/** The change flow's exit for a change handed to the role behind its run. */
export const HANDED_EXIT = "handed";

/** The server's refusal when a role's merge switch is off. */
export const roleMergeOffReason = (handle: string) => `@${handle}'s merge is off: \`cast role line @${handle} --merge on\` lets its hands merge`;

/** The refusal when the switch is off and no role's handle is known. */
export const MERGE_OFF_REASON = "merge is off for this flow; a person turns it on with cast role line --merge on";

/** A line saying a merge switch is off, after any prefix a stop, a line merge or a ship step puts before it. */
export const MERGE_OFF = /^\s*(?:Stopped:\s*)?(?:merge left to a person:\s*|not merged:\s*)?(?:merge is off for this (?:flow|line)\b|@([\w-]+)'s merge is off\b)/im;

/** Whether the text says a merge switch is off (any line of it). */
export const mergeOffIn = (text: string | null | undefined): boolean => MERGE_OFF.test(text ?? "");

/** The role whose merge switch the text says is off, or null (off for no named role, or not off). */
export const mergeOffRole = (text: string | null | undefined): string | null => MERGE_OFF.exec(text ?? "")?.[1] ?? null;

/** The Merge station's words when it hands the change to the role (exit 5). */
export const handedWords = (handle: string, reason: string) => `Merge is @${handle}'s: handed to it. ${reason}.`;

/** The role a Merge station's words handed the change to, or null. */
export const handedRole = (text: string | null | undefined): string | null => /\bMerge is @([\w-]+)'s: handed to it\b/.exec(text ?? "")?.[1] ?? null;

/** A run that ended handed to its role and records no merge yet: its change is not on main, and its task is not done. */
export const handedUnmerged = (run: { status?: string; current_node_id?: string | null; merge?: { sha?: string | null } | null } | null | undefined): boolean =>
  !!run && run.status === "completed" && run.current_node_id === HANDED_EXIT && !run.merge?.sha;
