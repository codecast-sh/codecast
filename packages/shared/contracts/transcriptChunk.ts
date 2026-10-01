// The one way huddle transcript segments become message text, shared by the
// server's route delivery and the web's "send to agent" actions so an agent
// sees the same shape however the words reach it.
//
// The words reach an agent in one of two LANES, and the lane is the first
// thing the agent reads:
//   ask      the words name the agent (its character name, or its brand said
//            as a name: "Claude, ..."). An answer is expected, and the chunk
//            reaches the agent at once, mid-turn if need be.
//   context  the room talking among itself. No answer is owed; the chunk
//            waits while the agent works and arrives as one catch up when the
//            turn ends. `addressesAgent` decides the lane on both sides.
import { AGENT_CLIENTS, fromConvexAgentType } from "./agentClients";

export type TranscriptChunkSegment = { speaker_name: string; text: string };

// Collapse consecutive segments from one speaker into one line — the readable
// Otter shape: "**Name**: sentence sentence".
export function formatTranscriptChunk(segments: TranscriptChunkSegment[]): string {
  const lines: string[] = [];
  for (const s of segments) {
    const prefix = `**${s.speaker_name}**: `;
    if (lines.length && lines[lines.length - 1].startsWith(prefix)) {
      lines[lines.length - 1] += " " + s.text;
    } else {
      lines.push(prefix + s.text);
    }
  }
  return lines.join("\n");
}

export type ChunkLane = "ask" | "context";

export type ChunkHeaderOpts = {
  /** What the room calls this agent: its character name. */
  name: string;
  lane: ChunkLane;
  /** The words waited while the agent worked, or while it held the room off
   *  with `cast call hold`, and arrive together as one catch up. */
  held: boolean;
  /** Carry the whole framing (lane, reply and hold notes). Off, the header
   *  is one line that names the lane; see `needsFullBrief`. */
  full: boolean;
};

// The full framing is several paragraphs, and a live feed sends a chunk at
// every pause in the room. It leads the first chunk a route delivers and
// every Nth after that, so an agent whose context was compacted meets it
// again; every other chunk carries the one line header.
export const HUDDLE_REBRIEF_EVERY = 8;

/** Whether the next chunk on a route carries the full framing, given how
 *  many chunks it has delivered since the last one that did. */
export function needsFullBrief(chunksSinceBrief: number | undefined): boolean {
  return chunksSinceBrief === undefined || chunksSinceBrief >= HUDDLE_REBRIEF_EVERY;
}

/** The names a spoken line may use for an agent: its character name, and its
 *  brand said as a name ("Claude", "Codex"). A room with one Claude in it
 *  says "Claude" and means it; a room with two has both answer, which is
 *  what two people called Sam do too. */
export function agentSpokenNames(opts: { name: string; agentType?: string | null }): string[] {
  const out = [opts.name.trim()].filter(Boolean);
  if (opts.agentType) {
    const brand = AGENT_CLIENTS[fromConvexAgentType(opts.agentType)]?.displayName?.trim();
    if (brand && !out.some((n) => n.toLowerCase() === brand.toLowerCase())) out.push(brand);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this text speak TO the agent? A whole word match on any of its
 *  names, case folded, so "ember" in "remember" does not count. Speech
 *  arrives from a recognizer, so nothing here relies on punctuation. */
export function addressesAgent(text: string, names: readonly string[]): boolean {
  const t = text ?? "";
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, "iu");
    if (re.test(t)) return true;
  }
  return false;
}

// A turn always ends on some words, and those words are mirrored into the
// room. Ending on exactly this is how a fed session says it has nothing for
// the room: the mirror posts nothing for it (callChat.mirrorAgentTurn).
export const HUDDLE_PASS = "[pass]";

export function isHuddlePass(text: string | null | undefined): boolean {
  return (text ?? "").trim().toLowerCase() === HUDDLE_PASS;
}

// What every session fed a live huddle is told about where its words go: the
// reply it ends its turn with is shown in the huddle's chat, beside the people
// talking, unless it passes. Said in one place so the briefing, the own-room
// header and the generic feed header cannot drift apart on this.
export const HUDDLE_REPLY_NOTE =
  `Your reply at the end of this turn is shown in the huddle's chat, next to the people talking, and anything they type in that chat reaches you here. Keep it short and conversational, the way you would speak in a room; put long output in a doc or a file and say where it is. When you have nothing the room needs, end the turn with exactly ${HUDDLE_PASS} and nothing else: the room sees nothing. Never post a line only to say you are listening or following along.`;

// How an agent asks the room for time. The words keep flowing into the
// transcript; they arrive together when the hold ends, and a line that names
// the agent still comes through at once.
export const HUDDLE_HOLD_NOTE =
  "When you need a stretch of uninterrupted work, run `cast call hold 3m` (any duration; `cast call hold off` releases it). The room's words wait and arrive together when the hold ends. A line that names you still reaches you at once.";

const LANE_NOTE: Record<ChunkLane, string> = {
  ask: "They named you, so answer here as you would answer anything typed to you. Wait for a complete thought before acting on it; speech arrives in pieces.",
  context:
    "Nobody named you, so no reply is owed: this is what the room is saying, for context. Carry on with what you were doing unless something here is for you or you can add something the room needs. When there is nothing to add, pass.",
};

const LANE_LINE: Record<ChunkLane, string> = {
  ask: "They named you: answer, briefly, once the thought is complete.",
  context: `Nobody named you: end with ${HUDDLE_PASS} unless the room needs something from you.`,
};

const HELD_NOTE = "These words waited while you worked and arrive together as one catch up.";

// The lead-in for the live feed of a session's OWN huddle. Every other feed
// reports a meeting that happened somewhere else; this one is people talking
// to this agent in this session's room, so it says that instead — and says
// that more is coming, or the agent treats a mid-sentence pause as the end of
// the thought and answers a half-finished ask.
export function ownRoomChunkHeader(opts: ChunkHeaderOpts): string {
  if (!opts.full) return shortHeader(`Your huddle, where you are ${opts.name}.`, opts);
  return [
    `People are talking in this session's huddle, where you are ${opts.name}. Below is what they said, transcribed as they said it — speaker attribution is exact, and more will arrive while the huddle runs.${opts.held ? ` ${HELD_NOTE}` : ""}`,
    LANE_NOTE[opts.lane],
    HUDDLE_REPLY_NOTE,
    HUDDLE_HOLD_NOTE,
  ].join("\n\n");
}

// The lead-in for the live feed of a huddle that is NOT this session's own:
// a meeting happening elsewhere, pointed at this agent by a participant.
export function liveFeedChunkHeader(opts: ChunkHeaderOpts): string {
  if (!opts.full) return shortHeader(`Huddle (live), where you are ${opts.name}.`, opts);
  return [
    `Huddle transcript (live). You are in the room as ${opts.name}.${opts.held ? ` ${HELD_NOTE}` : ""}`,
    LANE_NOTE[opts.lane],
    HUDDLE_REPLY_NOTE,
    HUDDLE_HOLD_NOTE,
  ].join("\n\n");
}

function shortHeader(lead: string, opts: ChunkHeaderOpts): string {
  return [lead, opts.held ? HELD_NOTE : null, LANE_LINE[opts.lane]].filter(Boolean).join(" ");
}

/** The first message a session spawned FOR a huddle reads: what it is
 *  attached to, what the room calls it, and how its words travel. */
export function huddleFeedBriefing(opts: { name: string; label: string }): string {
  return [
    `You're being attached to a live team huddle (${opts.label}). In the room you are ${opts.name}: people say that name when they want you, and it is the name beside your replies in the huddle's chat.`,
    "Attributed transcript chunks arrive here whenever the room pauses. Follow along and reply with anything genuinely useful — answers to questions raised, relevant context, pushback. The room is mid-conversation.",
    HUDDLE_REPLY_NOTE,
    HUDDLE_HOLD_NOTE,
  ].join("\n\n");
}

// A line somebody typed in the huddle's chat, on its way to a fed session.
export function huddleChatLineHeader(name: string): string {
  return `${name} wrote in the huddle's chat (the text lane beside the live words). Answer as you would answer a line typed to you; your reply lands back in that chat.`;
}

// The lead-in line for a one-shot excerpt handed to an agent session. Kept
// beside the formatter so every sender introduces the words the same way.
export function transcriptChunkHeader(opts: {
  title?: string | null;
  startedAt: number;
  live: boolean;
  partial: boolean;
}): string {
  const when = new Date(opts.startedAt).toISOString().slice(0, 16).replace("T", " ");
  return `${opts.partial ? "Excerpt from a" : "A"} team huddle transcript${
    opts.title ? ` — "${opts.title}"` : ""
  } (${when}${opts.live ? ", still live" : ""}). Speaker attribution is exact.`;
}
