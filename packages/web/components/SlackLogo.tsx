// The Slack mark, in Slack's own four colours. The one brand asset the app
// draws: everywhere a line, a channel or a button is ABOUT Slack, this is the
// glyph, so a reader learns it once. `muted` greys it for a disconnected or
// paused state.
export function SlackLogo({ className, muted, title }: { className?: string; muted?: boolean; title?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 122.8 122.8"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={muted ? { filter: "grayscale(1)", opacity: 0.55 } : undefined}
    >
      {title && <title>{title}</title>}
      <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9z" fill="#E01E5A" />
      <path d="M32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 0 1-25.8 0V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2z" fill="#36C5F0" />
      <path d="M45.2 32.3a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z" fill="#36C5F0" />
      <path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2z" fill="#2EB67D" />
      <path d="M90.5 45.2a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 0 1 25.8 0v32.3z" fill="#2EB67D" />
      <path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9z" fill="#ECB22E" />
      <path d="M77.6 90.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6z" fill="#ECB22E" />
    </svg>
  );
}
