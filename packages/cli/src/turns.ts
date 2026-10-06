/**
 * Turn snapshots from the CLI's side: list a session's snapshots, name the
 * turn each one closes, pick the snapshot that stood at a given message, and
 * make its objects reachable in a checkout so git can diff or restore them.
 *
 * The rows come from the server (treeSnapshots.listForConversation); the
 * objects live in the session's repository and reach another machine on the
 * hidden wip ref, which the daemon pushes with the chain behind it.
 */

import { git, gitTry, wipRef } from "./wipSnapshot.js";

export interface TurnSnapshotRow {
  sha: string;
  tree_sha: string;
  base_sha: string;
  prev_sha?: string;
  branch?: string;
  depth: number;
  changed_paths: string[];
  changed_count: number;
  dirty: boolean;
  source: "turn" | "sweep";
  taken_at: number;
  turn_completed_at?: number;
  took_ms?: number;
}

export interface TurnMessage {
  role: string;
  content?: string;
  timestamp?: number | string;
}

/** A snapshot with the turn it closes: the person's ask that started the turn, and its line in `cast read` numbering. */
export interface LabeledTurn {
  index: number;
  row: TurnSnapshotRow;
  /** 1-based line of the human message that started the turn, when one precedes the snapshot. */
  askLine?: number;
  ask?: string;
  /** Lines of the transcript this snapshot closes: from the ask to the last message before the snapshot. */
  lastLine?: number;
}

function ms(t: number | string | undefined): number {
  if (t === undefined) return 0;
  return typeof t === "number" ? t : Date.parse(t) || 0;
}

/** The moment a snapshot describes: the turn's end when it closed one, else when it was taken. */
export function snapshotMoment(row: Pick<TurnSnapshotRow, "taken_at" | "turn_completed_at">): number {
  return row.turn_completed_at ?? row.taken_at;
}

const ASK_CLIP = 72;
function clipAsk(content: string | undefined): string | undefined {
  const line = (content ?? "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > ASK_CLIP ? `${line.slice(0, ASK_CLIP - 1)}…` : line;
}

/**
 * Name each snapshot by the turn it closes. Messages are in `cast read` order
 * (line N is messages[N-1]). A snapshot closes the turn whose human message is
 * the last one at or before the snapshot's moment that is not itself already
 * closed by an earlier snapshot; a sweep that found nothing new carries no
 * turn and keeps the previous ask.
 */
export function labelTurns(rows: TurnSnapshotRow[], messages: TurnMessage[]): LabeledTurn[] {
  const sorted = [...rows].sort((a, b) => snapshotMoment(a) - snapshotMoment(b));
  const out: LabeledTurn[] = [];
  let cursor = 0; // messages consumed by earlier snapshots
  sorted.forEach((row, i) => {
    const at = snapshotMoment(row);
    let lastLine: number | undefined;
    let askLine: number | undefined;
    let ask: string | undefined;
    for (let n = cursor; n < messages.length; n++) {
      if (ms(messages[n].timestamp) > at) break;
      lastLine = n + 1;
      if (messages[n].role === "human" || messages[n].role === "user") {
        if (askLine === undefined) {
          askLine = n + 1;
          ask = clipAsk(messages[n].content);
        }
      }
    }
    if (lastLine !== undefined) cursor = lastLine;
    out.push({ index: i + 1, row, askLine, ask, lastLine });
  });
  return out;
}

/**
 * The snapshot that stood at message `line` (1-based, `cast read` numbering):
 * the newest whose moment is at or before that message's time. Null when no
 * snapshot is that old; the caller then starts from the base commit.
 */
export function snapshotAtLine(rows: TurnSnapshotRow[], messages: TurnMessage[], line: number): TurnSnapshotRow | null {
  const msg = messages[line - 1];
  if (!msg) return null;
  const at = ms(msg.timestamp);
  let best: TurnSnapshotRow | null = null;
  for (const row of rows) {
    const m = snapshotMoment(row);
    if (m <= at && (!best || m > snapshotMoment(best))) best = row;
  }
  return best;
}

/**
 * Make `sha` reachable in `cwd`: already there when this machine took it,
 * else fetched on the session's wip ref from the remote (the chain travels
 * with the tip, so any snapshot the tip descends from arrives too).
 */
export async function ensureSnapshotLocal(cwd: string, sha: string, conversationId: string, remote: string | null): Promise<boolean> {
  if ((await gitTry(cwd, ["cat-file", "-e", `${sha}^{commit}`])) !== null) return true;
  if (!remote) return false;
  const ref = wipRef(conversationId);
  if ((await gitTry(cwd, ["fetch", "--quiet", "--force", "--no-tags", remote, `+${ref}:${ref}`])) === null) return false;
  return (await gitTry(cwd, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
}

/** `git diff` between the trees of two snapshots (or a snapshot's base and itself). */
export async function diffBetween(cwd: string, from: string, to: string, opts: { stat?: boolean; paths?: string[] } = {}): Promise<string | null> {
  const args = ["diff", "--no-color", ...(opts.stat ? ["--stat"] : []), `${from}^{tree}`, `${to}^{tree}`, ...(opts.paths?.length ? ["--", ...opts.paths] : [])];
  return gitTry(cwd, args);
}

export { git };
