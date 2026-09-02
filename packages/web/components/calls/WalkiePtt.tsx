// The mic button. The gesture it carries lives in hooks/useWalkie; this is only
// what the talk toggle looks like, so the composer, a hover card and the receiver banner
// can each dress the same press differently.
import { Mic } from "lucide-react";
import { talkToggleProps, usePushToTalk, useWalkieLevelVar, walkieKeyName, walkieKeyState } from "../../hooks/useWalkie";
import "./walkie.css";

export function WalkiePttButton({
  roomKey,
  resolveChannelId,
  label,
  className,
  title,
  size = "md",
}: {
  roomKey: string | undefined;
  /** Called at press time, not at render: for a hover card the answer is "open
   *  the DM with this person", which must not happen merely on hover. */
  resolveChannelId: () => string | null;
  /** Absent = icon only, the composer's shape. */
  label?: string;
  className?: string;
  /** Overrides the idle tooltip; a blocked reason always wins over it. */
  title?: string;
  /** How big the key is: 28px where it is one of several row actions, 40px in
   *  a composer, 52px where it IS the control — the strip. */
  size?: "sm" | "md" | "lg";
}) {
  const ptt = usePushToTalk(roomKey, resolveChannelId);
  // What a screen reader is told lives in walkieKeyName, beside the state
  // machine it mirrors — the two answer the same question for two senses and
  // must never disagree.
  //
  // THREE MOMENTS, NOT TWO, and the middle one is the whole redesign.
  //
  // `capturing` is the microphone being open: the recorder, the meter and the
  // recognizer are all running on it, so every word from here is kept. It is
  // true about a tenth of a second after the press. THAT is what the key lights
  // on, because it is the moment it becomes worth speaking.
  //
  // `live` is the later and different claim that somebody is hearing this AS IT
  // IS SAID — the track reaching the room, which took 1.0s into a warm room and
  // 12.7s into a cold one when it was measured. It is not a precondition for
  // talking, so it does not gate the lit key; it only decides whether the key
  // says "live to them" or "recording, they get it". The dot beside the glyph
  // carries that difference: filled once they hear you, hollow until then.
  //
  // The opening window between the press and the mic is now small enough to
  // barely be seen, and it still has its own honest state rather than being
  // papered over — a permission prompt or a busy device can widen it.
  //
  // And when the room goes away under a mic that WAS open, it says that too
  // rather than carrying on. The recording keeps running and the burst still
  // lands as a message, so this is not a failure — but nobody is hearing it,
  // and "live" would be a lie in the present tense.
  const state = walkieKeyState(ptt);
  const opening = state === "opening";
  // The ring only draws while this key's own mic is open, so a key on some
  // other surface is not paying for a subscription it never shows.
  const ref = useWalkieLevelVar<HTMLButtonElement>(state === "live");
  const name = walkieKeyName(state, { reason: ptt.reason, live: ptt.live, label, title });
  return (
    <button
      ref={ref}
      type="button"
      className={`walkie-ptt walkie-key walkie-key-${size} ${label ? "walkie-key-wide" : ""} ${className ?? ""} ${
        ptt.capturing ? "walkie-ptt-on" : ""
      } ${opening ? "walkie-ptt-opening" : ""} ${ptt.dropped ? "walkie-ptt-dropped" : ""} ${
        state === "locked" ? "walkie-ptt-locked" : ""
      }`}
      disabled={!!ptt.reason}
      data-walkie-ptt={roomKey ?? ""}
      data-walkie-state={state}
      aria-label={name}
      aria-pressed={ptt.holding}
      title={ptt.reason ?? (state === "idle" ? (title ?? "Talk — click to start, click again to stop") : name)}
      {...talkToggleProps(ptt)}
    >
      <span className="walkie-key-ring" aria-hidden="true" />
      <Mic className="walkie-key-glyph" />
      {/* Filled once the track has reached the room and a teammate at their desk
          is hearing this as it is spoken; hollow while it is only being kept.
          Both are true states of a working burst, so neither is a warning — the
          difference is between "live" and "recorded", which is exactly the
          difference a radio's own light makes. */}
      {state === "live" && (
        <span
          className={`walkie-key-heard ${ptt.live ? "walkie-key-heard-on" : ""}`}
          aria-hidden="true"
        />
      )}
      {label && (
        <span className="walkie-key-label">
          {state === "dropped"
            ? "Stop"
            : state === "opening"
              ? "Opening"
              : state === "live"
                ? "Stop"
                : state === "locked"
                  ? "On the line"
                  : label}
        </span>
      )}
    </button>
  );
}

/**
 * How loudly whoever is talking right now is actually talking: four bars that
 * rise with the voice.
 *
 * One custom property, `--level`, written straight onto this element by the
 * subscription in hooks/useWalkie — no React render per frame, which is the
 * same reason the key's ring is drawn this way and the reason the engine keeps
 * the level off its status object at all.
 *
 * Whose voice is the `identity` argument: absent is this machine's own
 * microphone while the key is down, a LiveKit participant identity is the
 * teammate being heard. `tone` is the direction, warm out and cool in, and it
 * is the only thing that differs between the sending meter and the receiving
 * one — which is why they are one component and not two.
 */
export function WalkieLevelBars({ identity, tone }: { identity?: string; tone: "tx" | "rx" }) {
  const ref = useWalkieLevelVar<HTMLSpanElement>(true, identity);
  return (
    <span ref={ref} className={`walkie-level walkie-level-${tone}`} aria-hidden="true">
      {/* Each bar's own multiplier, so the cluster has the shape of a meter
          rather than four columns moving as one. */}
      {[0.55, 1, 0.75, 0.4].map((b, i) => (
        <i key={i} style={{ ["--b" as string]: b }} />
      ))}
    </span>
  );
}
