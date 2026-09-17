// The Slack mark, in Slack's own four colours. The one brand asset the app
// draws: everywhere a line, a channel or a button is ABOUT Slack, this is the
// glyph, so a reader learns it once. `muted` greys it for a disconnected or
// paused state.
export const SLACK_MARK_VIEWBOX = "0 0 122.8 122.8";
/** The mark's eight lobes, as [path, fill]. The one place the geometry lives:
 *  the component below draws it, and the chat mention pill (a remark plugin
 *  that emits plain hast, not React) draws the same. */
export const SLACK_MARK_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9z", "#E01E5A"],
  ["M32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 0 1-25.8 0V77.6z", "#E01E5A"],
  ["M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2z", "#36C5F0"],
  ["M45.2 32.3a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z", "#36C5F0"],
  ["M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2z", "#2EB67D"],
  ["M90.5 45.2a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 0 1 25.8 0v32.3z", "#2EB67D"],
  ["M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9z", "#ECB22E"],
  ["M77.6 90.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6z", "#ECB22E"],
];

export function SlackLogo({ className, muted, title }: { className?: string; muted?: boolean; title?: string }) {
  return (
    <svg
      className={className}
      viewBox={SLACK_MARK_VIEWBOX}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={muted ? { filter: "grayscale(1)", opacity: 0.55 } : undefined}
    >
      {title && <title>{title}</title>}
      {SLACK_MARK_PATHS.map(([d, fill]) => <path key={d} d={d} fill={fill} />)}
    </svg>
  );
}
