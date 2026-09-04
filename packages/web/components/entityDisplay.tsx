import { AvatarImg } from "../lib/avatarCache";
import { FormattedSummary } from "./FormattedSummary";
import { sessionCardSummary } from "../lib/sessionSummary";
import { stripTranscriptTags } from "../lib/notificationText";

// A teammate's avatar for session references: the author's image, or a colored
// initial circle as fallback.
export function AuthorAvatar({
  name,
  avatar,
  size = 14,
}: {
  name?: string | null;
  avatar?: string | null;
  size?: number;
}) {
  const dim = { width: size, height: size };
  return (
    <AvatarImg
      src={avatar}
      alt={name ?? "author"}
      className="rounded-full object-cover ring-1 ring-sol-border/60"
      style={dim}
      fallback={
        <span
          className="inline-flex items-center justify-center rounded-full bg-sol-blue/20 text-sol-blue font-semibold leading-none ring-1 ring-sol-border/60"
          style={{ ...dim, fontSize: Math.round(size * 0.55) }}
        >
          {(name?.charAt(0) || "?").toUpperCase()}
        </span>
      }
    />
  );
}

// Summary + a bit of context for a session reference card: the coalesced
// one-line summary (idle_summary/subtitle, with Goal:/Next: labels bolded) plus
// the last message preview. Reused by the hover popover, the preview card, and
// the inline expand so "opening" a session reference shows what it's about,
// not just its metadata.
export function SessionSummaryBlock({
  session,
  className = "",
  clamp = true,
}: {
  session: any;
  className?: string;
  /** false renders the whole summary/preview — the expanded object card. */
  clamp?: boolean;
}) {
  const summary = sessionCardSummary(session);
  // The raw preview is a transcript slice: strip machine framing, and drop
  // the row when nothing readable survives (a preview that is ALL framing).
  const preview = stripTranscriptTags(session.last_message_preview ?? "");
  const showPreview = preview && preview !== summary;
  const role = session.last_message_role;
  if (!summary && !showPreview) return null;
  return (
    <div className={`space-y-1 ${className}`}>
      {summary && (
        <p className={`text-[11px] text-sol-text-muted leading-relaxed ${clamp ? "line-clamp-3" : ""} whitespace-pre-line`}>
          <FormattedSummary text={summary} />
        </p>
      )}
      {showPreview && (
        <div className="flex items-start gap-1 text-[10px] text-sol-text-dim leading-snug">
          <span className="flex-shrink-0 font-mono text-sol-cyan/60">{role && role !== "user" ? `${role}:` : ">"}</span>
          <span className={`${clamp ? "line-clamp-2" : "whitespace-pre-wrap"} min-w-0`}>{preview}</span>
        </div>
      )}
    </div>
  );
}
