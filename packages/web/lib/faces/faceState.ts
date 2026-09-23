export type FaceState =
  | "offline"
  | "away"
  | "idle"
  | "online"
  | "busy"
  /** Seated in a call the viewer is not in. */
  | "in-call"
  /** Their voice is active in the call the viewer is in (or the viewer's own). */
  | "speaking"
  /** The viewer is ringing them. */
  | "ringing-them"
  /** They are ringing the viewer. */
  | "ringing-me"
  /** Their walkie burst is playing on this machine right now. */
  | "talking-to-me"
  /** The viewer's burst is going out and they are seated to hear it. */
  | "hearing-me"
  /** Seated in the room the viewer holds, no voice going either way right now. */
  | "live-with-me"
  /** They stepped into the viewer's burst on purpose in the last few seconds. */
  | "joining";
