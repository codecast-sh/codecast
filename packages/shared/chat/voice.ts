// A push-to-talk burst is an ordinary chat message that grows in three steps
// instead of landing at once: it is created empty while the sender holds the
// key, the transcript streams into `content` as they talk, and release
// finalizes it with the final text, the recorded audio and its duration.
//
// The lifecycle lives on the row so server, web and mobile cannot disagree
// about which of those states counts as a message:
//
//   live      the sender is still talking. The transcript is partial and the
//             audio has not been uploaded yet.
//   done      the burst landed: final transcript, audio attached, duration
//             known. THIS is the state that notified.
//   canceled  a burst too short to mean anything, kept only because something
//             already pointed at the row.
export type ChatVoiceStatus = "live" | "done" | "canceled";

/**
 * A burst still being spoken. It renders (the live bubble IS the feature) but
 * it is not yet a message: it has not notified, so it must not tick an unread
 * badge or become a channel's last line. Both happen on finalize, once.
 */
export function isLiveVoiceRow(row: { voice?: { status?: string } | null }): boolean {
  return row.voice?.status === "live";
}
