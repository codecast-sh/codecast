import { SLACK_MARK_VIEWBOX, SLACK_MARK_PATHS } from "../lib/slackLogo";

/** `quiet` draws the mark as a faint one-colour silhouette, for lists where
 *  every row wears it (the channel rails); `muted` fades it further. */
export function SlackLogo({ className, muted, quiet, title }: { className?: string; muted?: boolean; quiet?: boolean; title?: string }) {
  const style = quiet
    ? { color: "var(--sol-text-dim)", opacity: muted ? 0.15 : 0.35 }
    : muted ? { filter: "grayscale(1)", opacity: 0.55 } : undefined;
  return (
    <svg
      className={className}
      viewBox={SLACK_MARK_VIEWBOX}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={style}
    >
      {title && <title>{title}</title>}
      {SLACK_MARK_PATHS.map(([d, fill]) => <path key={d} d={d} fill={quiet ? "currentColor" : fill} />)}
    </svg>
  );
}
