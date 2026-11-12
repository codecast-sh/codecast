import { memo } from "react";
import { Reply } from "lucide-react";
import { useEntityResolution } from "../../lib/entityDisplay";
import { parseDraftSessionsKey } from "../../lib/sessionReplyDraft";

// Every session a chat draft names, each a toggle: lit, the line asks it to
// reply; dark, the line only mentions it. The draft text is the record
// (lib/sessionReplyDraft), so the toggle rewrites the mention in place.
export const SessionReplyStrip = memo(function SessionReplyStrip({
  sessionsKey,
  onToggle,
}: {
  sessionsKey: string;
  onToggle: (id: string, ask: boolean, title: string | null) => void;
}) {
  const sessions = parseDraftSessionsKey(sessionsKey);
  if (sessions.length === 0) return null;
  return (
    <div className="ch-reply-strip" role="group" aria-label="Sessions asked to reply">
      <span className="ch-reply-strip-label">
        <Reply className="w-3 h-3" aria-hidden />
        Ask to reply
      </span>
      {sessions.map((s) => <SessionReplyToggle key={s.id} id={s.id} asks={s.asks} onToggle={onToggle} />)}
    </div>
  );
});

function SessionReplyToggle({ id, asks, onToggle }: { id: string; asks: boolean; onToggle: (id: string, ask: boolean, title: string | null) => void }) {
  const { entity, label, fullLabel } = useEntityResolution(id, "session");
  const title = entity?.title ?? (fullLabel && fullLabel !== id ? fullLabel : null);
  return (
    <button
      type="button"
      className="ch-reply-toggle"
      aria-pressed={asks}
      data-session={id}
      title={asks ? `${fullLabel} will reply. Click to only mention it.` : `Mentioned only. Click to ask ${fullLabel} to reply.`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onToggle(id, !asks, title)}
    >
      <span className="ch-reply-toggle-dot" aria-hidden />
      <span className="ch-reply-toggle-name">{label}</span>
    </button>
  );
}
