// The room reads top to bottom as its history: a version sits where it went
// live, not where it was asked for, so version numbers never run backwards
// after a restore or a rebased build. Chat stays where it was said.
import type { MessageView } from "../../convex/messages";

/** When a row took its place in the room: a version when it went live,
 *  everything else when it was said. */
const landedAt = (m: MessageView) => (m.build?.status === "live" && m.build.finished_at) || m.created_at;

/** The stream with each version where it landed. The sort is stable, so
 *  rows that landed together keep the order they were said in. */
export function inLandingOrder(messages: MessageView[]): MessageView[] {
  const ordered = messages.every((m, i) => i === 0 || landedAt(messages[i - 1]) <= landedAt(m));
  return ordered ? messages : messages.toSorted((a, b) => landedAt(a) - landedAt(b));
}
