/**
 * `cast diff <session> --turns` and `--turn N`: the file history of a session
 * by turn, from the daemon's turn snapshots (treeSnapshot.ts, recorded in
 * treeSnapshots.listForConversation). The listing is server data; a turn's
 * diff is read from git in the current checkout, fetching the session's wip
 * ref when the objects are not here.
 */

import { fmt } from "./colors.js";
import { formatRelativeTime } from "./formatter.js";
import { defaultRemote } from "./wipSnapshot.js";
import { diffBetween, ensureSnapshotLocal, labelTurns, snapshotMoment, type LabeledTurn, type TurnMessage, type TurnSnapshotRow } from "./turns.js";

export async function fetchTurnSnapshots(conversationId: string): Promise<TurnSnapshotRow[]> {
  const { convexClient } = await import("./remote/convexClient.js");
  const { client, token, api } = await convexClient({ timeoutMs: 20_000 });
  const rows: TurnSnapshotRow[] = await client.query(api.treeSnapshots.listForConversation, { api_token: token, conversation_id: conversationId });
  return rows;
}

function describe(t: LabeledTurn): string {
  const r = t.row;
  const what = r.changed_count === 0
    ? fmt.muted("no change")
    : `${r.changed_count} file${r.changed_count === 1 ? "" : "s"}`;
  const paths = r.changed_paths.slice(0, 3).join(", ") + (r.changed_count > 3 ? `, +${r.changed_count - 3}` : "");
  const when = formatRelativeTime(new Date(snapshotMoment(r)).toISOString());
  const ask = t.ask ? `  ${fmt.muted(`#${t.askLine}`)} ${t.ask}` : `  ${fmt.muted(r.source === "sweep" ? "sweep, no new turn" : "turn with no ask on record")}`;
  const shared = r.shared_sessions ? `  ${fmt.muted(`checkout shared with ${r.shared_sessions} other session${r.shared_sessions === 1 ? "" : "s"}; the changes may be theirs`)}` : "";
  return `${String(t.index).padStart(3)}  ${r.sha.slice(0, 10)}  ${when.padEnd(14)} ${what.padEnd(10)} ${fmt.muted(paths)}\n${ask}${shared ? `\n${shared}` : ""}`;
}

export async function printTurnSnapshots(opts: {
  conversationId: string;
  messages: TurnMessage[];
  cwd: string;
  turn?: string;
  stat: boolean;
}): Promise<void> {
  const rows = await fetchTurnSnapshots(opts.conversationId);
  if (!rows.length) {
    console.log("No turn snapshots for this session yet.");
    console.log(fmt.muted("The daemon records one at the end of every turn (cast 1.1.144 and later) and the sweep adds one every few minutes; a session that ran before that has none."));
    return;
  }
  const turns = labelTurns(rows, opts.messages);

  if (!opts.turn) {
    console.log(`${turns.length} turn snapshot${turns.length === 1 ? "" : "s"}  ${fmt.muted("(the working tree at each turn's end; shell and hand edits included)")}\n`);
    for (const t of turns) console.log(describe(t));
    console.log(`\n${fmt.muted("cast diff <session> --turn N   shows what turn N changed; --turn last for the newest")}`);
    return;
  }

  const pick = opts.turn === "last" ? turns[turns.length - 1] : turns.find((t) => t.index === Number(opts.turn));
  if (!pick) {
    console.error(`No turn ${opts.turn}; --turns lists ${turns.length}.`);
    process.exit(1);
  }
  const r = pick.row;
  const from = r.prev_sha ?? r.base_sha;
  const remote = await defaultRemote(opts.cwd);
  const here = await ensureSnapshotLocal(opts.cwd, r.sha, opts.conversationId, remote);
  const fromHere = here && (await ensureSnapshotLocal(opts.cwd, from, opts.conversationId, remote));
  if (!here || !fromHere) {
    console.error(`The snapshot objects are not in this checkout${remote ? ` and could not be fetched from ${remote}` : " and there is no remote to fetch them from"}.`);
    console.error(fmt.muted("Run this inside a checkout of the session's repository; the daemon that took the snapshot pushes them to refs/codecast/wip/<session> every few minutes."));
    process.exit(1);
  }
  console.log(`${fmt.muted(`turn ${pick.index}`)}  ${r.sha.slice(0, 10)}  ${pick.ask ?? ""}`);
  console.log(fmt.muted(`${from.slice(0, 10)} → ${r.sha.slice(0, 10)}, ${r.changed_count} file${r.changed_count === 1 ? "" : "s"}, taken ${formatRelativeTime(new Date(snapshotMoment(r)).toISOString())}${r.shared_sessions ? `; checkout shared with ${r.shared_sessions} other session${r.shared_sessions === 1 ? "" : "s"}` : ""}\n`));
  const out = await diffBetween(opts.cwd, from, r.sha, { stat: opts.stat });
  console.log(out && out.trim() ? out : fmt.muted("(no change)"));
}
