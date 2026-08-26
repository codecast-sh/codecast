import { PRESENCE_META, type PresenceVisual } from "./memberPresence";
import "./presence.css";

export type PresenceBadgeSize = "sm" | "md";

/**
 * The presence badge, and the only place presence is drawn.
 *
 * `sm` (10px) rides an avatar in a strip or a list row; `md` (14px) belongs on
 * a card or a roster row where it is a first-class signal. Offline renders an
 * empty span on purpose: nothing to read, but the space is still taken, so a
 * row keeps its rhythm when a teammate's daemon stops.
 *
 * A badge with no `title` is decoration — the surface next to it already says
 * the word — so it is hidden from the reader of a screen reader. Pass `title`
 * where the badge stands alone and it becomes a labelled image.
 */
export function PresenceBadge({
  state,
  size = "md",
  title,
  className = "",
}: {
  state: PresenceVisual;
  size?: PresenceBadgeSize;
  title?: string;
  className?: string;
}) {
  const meta = PRESENCE_META[state];
  return (
    <span
      className={`pres pres-${size} ${meta.badge} ${className}`.trim()}
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* The moon is a BITE out of the disc, in the surface colour, not a
          crescent drawn inside it: at 10px a stroked crescent turns to mush,
          while a big negative space still reads as a moon. */}
      {meta.glyph === "moon" && (
        <svg className="pres-glyph" viewBox="0 0 12 12">
          <circle cx="9.4" cy="2.6" r="4.8" />
        </svg>
      )}
      {meta.glyph === "minus" && (
        <svg className="pres-glyph" viewBox="0 0 12 12">
          <rect x="3" y="5.3" width="6" height="1.6" rx="0.8" />
        </svg>
      )}
    </span>
  );
}
