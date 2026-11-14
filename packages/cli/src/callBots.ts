// `cast call join <meeting link>` and `cast call leave <bot>`: send a
// codecast bot (Recall.ai) to a Zoom, Google Meet, Teams, Webex or GoTo
// meeting, or take it out. The meeting becomes an ordinary call (cl-N) once
// the bot is in and recording; run from a session, its words feed that
// session live. The server checks the link, so this file only shapes words.

export type MeetingBotRow = {
  meet_id: string;
  meeting_url: string;
  platform_name: string;
  status: string;
  status_words: string | null;
  join_at: number | null;
  transcript_id: string | null;
};

type Deps = {
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  session?: string;
  json?: boolean;
  log?: (line: string) => void;
};

const STATUS_WORDS: Record<string, string> = {
  requested: "on its way",
  scheduled: "scheduled",
  joining: "joining",
  waiting_room: "in the waiting room, waiting to be let in",
  in_call: "in the meeting, not recording yet",
  recording: "in the meeting, transcribing",
  ended: "left the meeting",
  failed: "could not join",
  cancelled: "removed",
};

export function describeBot(b: MeetingBotRow): string {
  const state = STATUS_WORDS[b.status] ?? b.status;
  const when = b.status === "scheduled" && b.join_at ? ` for ${new Date(b.join_at).toLocaleString()}` : "";
  const why = b.status_words ? ` (${b.status_words})` : "";
  return `${b.platform_name} bot ${b.meet_id.slice(0, 8)}: ${state}${when}${why}`;
}

/** "in 15m", "15m", an ISO time or a clock time today, as epoch ms. */
export function parseJoinAt(spec: string | undefined, now = Date.now()): number | undefined {
  if (!spec) return undefined;
  const rel = spec.trim().replace(/^in\s+/i, "").match(/^(\d+)\s*(m|min|h|hr)$/i);
  if (rel) return now + Number(rel[1]) * (/^h/i.test(rel[2]) ? 3_600_000 : 60_000);
  const at = Date.parse(spec);
  if (Number.isFinite(at)) return at;
  throw new Error(`Could not read "${spec}" as a time: use 15m, 2h or an ISO time`);
}

export async function runCallJoin(url: string | undefined, opts: { at?: string; noFeed?: boolean }, deps: Deps): Promise<MeetingBotRow> {
  const log = deps.log ?? console.log;
  if (!url) throw new Error("Give the meeting link: cast call join https://meet.google.com/abc-defg-hij");
  const bot: MeetingBotRow = await deps.post("/cli/calls/bots/send", {
    meeting_url: url,
    ...(opts.at ? { join_at: parseJoinAt(opts.at) } : {}),
    ...(deps.session && !opts.noFeed ? { session: deps.session } : {}),
  });
  if (deps.json) {
    log(JSON.stringify(bot, null, 2));
    return bot;
  }
  log(describeBot(bot));
  log(
    deps.session && !opts.noFeed
      ? "The meeting's words reach this session live once the bot is let in. `cast calls` lists the call."
      : "The meeting becomes a call in `cast calls` once the bot is let in.",
  );
  log(`Take it out: cast call leave ${bot.meet_id.slice(0, 8)}`);
  return bot;
}

/** `leave` with no id takes out the only bot still going; with several, it
 *  names them rather than guess. */
export async function runCallLeave(ref: string | undefined, deps: Deps): Promise<MeetingBotRow> {
  const log = deps.log ?? console.log;
  const mine: MeetingBotRow[] = await deps.post("/cli/calls/bots/list", { limit: 50 });
  const going = mine.filter((b) => !["ended", "failed", "cancelled"].includes(b.status));
  const pick = ref ? mine.filter((b) => b.meet_id.startsWith(ref)) : going;
  if (pick.length !== 1) {
    const list = (ref ? pick : going).map((b) => `  ${describeBot(b)}`).join("\n");
    throw new Error(
      pick.length === 0
        ? ref ? `No meeting bot ${ref}` : "No meeting bot is going"
        : `Several meeting bots match; name one:\n${list}`,
    );
  }
  const out: MeetingBotRow = await deps.post("/cli/calls/bots/cancel", { meet_id: pick[0].meet_id });
  log(deps.json ? JSON.stringify(out, null, 2) : describeBot(out));
  return out;
}
