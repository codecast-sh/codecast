// A commit's Codecast-Session trailer, shown as the session it names rather
// than a raw URL. The trailer is added by the session trailer hook to each
// commit an agent runs (packages/cli/src/sessionTrailer.ts); the same parser
// the server trusts (splitSessionTrailer) takes the line out of the message (hooks/useSessionTrailer).
import { SESSION_TRAILER_KEY } from "@codecast/shared/blame";
import { EntityIdPill } from "./EntityIdPill";

/** The trailer line as the message showed it: its key, then the session as a pill. */
export function SessionTrailerLine({ session, className }: { session: string; className?: string }) {
  return (
    <div className={`flex items-center gap-1.5 min-w-0 text-[11px] text-sol-text-dim ${className ?? ""}`}>
      <span className="font-mono shrink-0">{SESSION_TRAILER_KEY}</span>
      <EntityIdPill type="session" id={session} />
    </div>
  );
}
