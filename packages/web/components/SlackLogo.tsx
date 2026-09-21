import { SLACK_MARK_VIEWBOX, SLACK_MARK_PATHS } from "../lib/slackLogo";

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
