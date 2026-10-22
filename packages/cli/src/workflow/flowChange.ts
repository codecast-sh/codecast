// How a session's change enters a flow (docs/architecture/flows.md FL4). A
// session in a shared checkout leaves its edits uncommitted beside everyone
// else's; the flow runs on a commit of exactly that session's files, made from
// the frozen tree the way `cast ship checkout` makes its commits, on a branch
// of its own, so nothing in the shared tree moves.
//
// Every file the session wrote goes in, including one another session also
// wrote after it (attribution is per file, so that file carries the other
// session's lines too, and the change says so). Dropping a file the session
// wrote would run the flow on part of its change, which is worse than carrying
// a neighbour's edit the change names.
import { buildCommits } from "../land/commitGroups.js";
import { defaultMessage, freezeAndAttribute } from "../land/shipCheckout.js";
import type { SessionEdits } from "../land/attribute.js";
import { git } from "../wipSnapshot.js";
import type { FrozenChange } from "./flowChangeFile.js";
export { frozenChangeContext, writeFrozenChange, type FrozenChange } from "./flowChangeFile.js";

/** Whether `ref` (a codecast id, its 7-character short id, or the agent's own session id) names this session. */
export function sessionMatches(s: Pick<SessionEdits, "conversationId" | "sessionId">, ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  if (s.sessionId === r) return true;
  const conv = s.conversationId ?? "";
  return !!conv && (conv === r || (r.length >= 7 && conv.startsWith(r)));
}

const idOf = (s: SessionEdits) => s.conversationId?.slice(0, 7) ?? s.sessionId.slice(0, 8);

/** What a session's change would hold, read from the frozen tree: its files, the ones another session also wrote, and the ones held out. */
export async function previewSessionChange(root: string, session: string) {
  const { frozen, attribution, credentials } = await freezeAndAttribute(root);
  const mine = attribution.sessions.find((s) => sessionMatches(s, session));
  if (!mine) throw new Error(`No uncommitted change in ${root} was written by session ${session}`);
  const wrote = frozen.changes.map((c) => c.path).filter((p) => mine.edits.has(p));
  const held = wrote.filter((p) => credentials.has(p)).map((p) => ({ path: p, why: credentials.get(p)! }));
  const paths = wrote.filter((p) => !credentials.has(p)).sort();
  const shared = paths
    .map((p) => ({ path: p, also: attribution.sessions.filter((s) => s !== mine && s.edits.has(p)).map(idOf) }))
    .filter((s) => s.also.length);
  return { frozen, session: idOf(mine), paths, shared, held };
}

/**
 * Commit the files `session` wrote, at their frozen content, on top of the
 * checkout's HEAD, and point `branch` at it. The shared tree, its index and
 * HEAD are untouched. Throws when the session wrote nothing that is changed.
 */
export async function freezeSessionChange(root: string, session: string, opts: { branch: string; worktree: string; title?: string | null }): Promise<FrozenChange> {
  const { frozen, session: id, paths, shared, held } = await previewSessionChange(root, session);
  if (!paths.length) throw new Error(`Session ${id} wrote nothing here that can go in a change${held.length ? ` (held: ${held.map((h) => `${h.path}, ${h.why}`).join("; ")})` : ""}`);
  const { tip } = await buildCommits(root, frozen, [{ message: defaultMessage(opts.title ?? null, paths), paths }]);
  await git(root, ["update-ref", `refs/heads/${opts.branch}`, tip]);
  return { source: "session", session: id, base: frozen.base, tip, branch: opts.branch, worktree: opts.worktree, paths, shared, held };
}
