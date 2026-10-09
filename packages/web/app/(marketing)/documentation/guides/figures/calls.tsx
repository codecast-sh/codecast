"use client";

import { SOL } from "../../../blog/blogChrome";
import { ChannelDigest, CitationMessage, HuddleChat, PeopleWall, WalkieBurst } from "../../../features/calls/mocks";
import "../../../features/calls/calls.css";

/**
 * Figures for the calls guide, drawn with the calls feature page's own
 * pieces: the digest a huddle leaves, a session taking part in a huddle,
 * an agent quoting the call, and the people wall with a walkie burst.
 */

function Paper({ children }: { children: React.ReactNode }) {
  return <div className="cc-root p-4 sm:p-6" style={{ backgroundColor: SOL.base3 }}>{children}</div>;
}

/** The digest a channel huddle leaves behind as a chat message. */
export function DigestFigure() {
  return <Paper><ChannelDigest /></Paper>;
}

/** A session in the huddle: a person's typed line goes in, the agent's answer comes back. */
export function HuddleAgentFigure() {
  return <Paper><HuddleChat /></Paper>;
}

/** An agent quoting the call, the speaker's name on each line. */
export function CitationFigure() {
  return <Paper><CitationMessage /></Paper>;
}

/** The people wall beside a walkie burst landing in a DM. */
export function WalkieFigure() {
  return (
    <Paper>
      <div className="grid gap-5 md:grid-cols-2">
        <PeopleWall />
        <WalkieBurst />
      </div>
    </Paper>
  );
}
