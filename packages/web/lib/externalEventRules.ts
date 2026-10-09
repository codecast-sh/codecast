// An external event's icon-free presentation rules (lib/externalEvents): the
// accent a source picks and the solarized token it draws in, and which kinds
// carry no news.
//
// They live apart from externalEvents because that module also holds the
// per-kind icon table, from lucide-react, and the phone reaches these: its PR
// screen colours its timeline rows with `accentVar` and drops quiet kinds. An
// import of the icon-bearing module from there resolves lucide-react out of
// packages/web/node_modules and bundles all ~3,800 icons into the native app
// (the class of incident CLAUDE.md records for `@sentry/react`, and the
// reason `lucide-react` is named in mobile's lib/bundleGraph.guard.test.ts).
// lib/externalEvents re-exports all of this, so a web caller can keep reading
// it there.

/** Accent names map to the app's solarized tokens (see accentVar). */
export type ExternalEventAccent =
  | "green"
  | "red"
  | "yellow"
  | "blue"
  | "violet"
  | "cyan"
  | "magenta"
  | "orange"
  | "muted";

const ACCENT_VARS: Record<ExternalEventAccent, string> = {
  green: "var(--sol-green)",
  red: "var(--sol-red)",
  yellow: "var(--sol-yellow)",
  blue: "var(--sol-blue)",
  violet: "var(--sol-violet)",
  cyan: "var(--sol-cyan)",
  magenta: "var(--sol-magenta)",
  orange: "var(--sol-orange)",
  muted: "var(--sol-text-muted)",
};

/** The css color for an accent. Use this instead of writing a hex anywhere. */
export function accentVar(accent: ExternalEventAccent | undefined): string {
  return ACCENT_VARS[accent ?? "muted"];
}

/** A soft fill of the same accent, for chips and rails. */
export function accentSoft(accent: ExternalEventAccent | undefined, percent = 14): string {
  return `color-mix(in srgb, ${accentVar(accent)} ${percent}%, transparent)`;
}

/**
 * Kinds that carry no news for a reader. "Fell behind" is a state the
 * shepherd acts on by itself and the PR chip already shows; the row that
 * announces it is noise on every other surface.
 */
export const QUIET_EXTERNAL_EVENT_KINDS: ReadonlySet<string> = new Set(["pr_behind"]);

export function isQuietExternalEvent(row: { kind?: string }): boolean {
  return QUIET_EXTERNAL_EVENT_KINDS.has(row.kind ?? "");
}
