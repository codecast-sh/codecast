// The card's title line (docs/architecture/session-characters.md S3).
//
// Personified: the NAME leads and carries the weight and the full text colour,
// because the name is what the eye learns and returns to; what the session is
// working on follows in a dimmer tone, present but secondary. Not personified:
// the title alone, exactly as the card has always read.
//
// The name never truncates; the title does.
import type { ReactNode } from "react";
import { identityLine, type IdentityRow } from "../../lib/sessionIdentity";
import { usePersonifyAll } from "../../hooks/usePersonifyAll";

export function SessionIdentityLine({
  row, title, className, nameClassName, titleClassName, after,
}: {
  row: IdentityRow;
  /** The display title, already cleaned by the caller. */
  title: string | null | undefined;
  className?: string;
  nameClassName?: string;
  titleClassName?: string;
  /** Chips that follow the title on the same line. */
  after?: ReactNode;
}) {
  const line = identityLine(row, title, usePersonifyAll());
  return (
    // data-sv-title marks the row's title line for the minimal style's type
    // rule (globals.css). It sits on the whole line, not just the title text:
    // once personified the name leads the line, so the rule has to take both.
    <span data-sv-title className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ""}`}>
      {line.name && (
        <span className={`flex-shrink-0 font-medium text-sol-text ${nameClassName ?? ""}`}>{line.name}</span>
      )}
      {line.handle && <span className="flex-shrink-0 text-sol-text-dim font-mono text-[0.85em]">@{line.handle}</span>}
      {line.name && line.title && <span aria-hidden className="flex-shrink-0 text-sol-text-dim/60">:</span>}
      {line.title && (
        <span className={`min-w-0 truncate ${line.name ? "text-sol-text-dim" : "text-sol-text"} ${titleClassName ?? ""}`}>
          {line.title}
        </span>
      )}
      {after}
    </span>
  );
}
