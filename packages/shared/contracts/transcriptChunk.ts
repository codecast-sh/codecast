// The one way huddle transcript segments become message text, shared by the
// server's route delivery and the web's "send to agent" actions so an agent
// sees the same shape however the words reach it.

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

// The lead-in for the live feed of a session's OWN huddle. Every other feed
// reports a meeting that happened somewhere else; this one is people talking
// to this agent in this session's room, so it says that instead — and says
// that more is coming, or the agent treats a mid-sentence pause as the end of
// the thought and answers a half-finished ask.
export function ownRoomChunkHeader(): string {
  return [
    "Someone is speaking in this session's huddle. Below is what they just said, transcribed as they said it — speaker attribution is exact, and more will arrive while the huddle runs.",
    "They are watching this session, so answer here as you would answer anything typed to you. Wait for a complete thought before acting on it; speech arrives in pieces.",
    HUDDLE_REPLY_NOTE,
  ].join("\n\n");
}

// What every session fed a live huddle is told about where its words go: the
// reply it ends its turn with is shown in the huddle's chat, beside the people
// talking. Said in one place so the briefing, the own-room header and the
// generic feed header cannot drift apart on this.
export const HUDDLE_REPLY_NOTE =
  "Your reply at the end of this turn is shown in the huddle's chat, next to the people talking, and anything they type in that chat reaches you here. Keep it short and conversational, the way you would speak in a room; put long output in a doc or a file and say where it is.";

// The lead-in for the live feed of a huddle that is NOT this session's own:
// a meeting happening elsewhere, pointed at this agent by a participant.
export function liveFeedChunkHeader(): string {
  return `Huddle transcript (live)\n\n${HUDDLE_REPLY_NOTE}`;
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
