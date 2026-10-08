// The replay player's iframe (docs/architecture/external-data.md X5,
// "Playing a replay"). Its link and message channel are hooks/useReplayPlayer.
import type { CSSProperties, RefObject } from "react";

/**
 * The iframe itself. Scripts run (the player's own; the recorded page is drawn
 * by it into a frame that cannot run any), and allow-same-origin keeps the
 * player on its real origin, which is never this one, so its messages carry
 * that origin and its reads stay its own. No referrer, no popups, no forms.
 */
export function ReplayPlayerIframe({
  frameRef,
  url,
  title,
  className,
  style,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  url: string;
  title: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <iframe
      ref={frameRef}
      src={url}
      title={title}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      allow=""
      loading="eager"
      className={className}
      style={{ border: 0, display: "block", width: "100%", ...style }}
    />
  );
}
