// One message a search found, drawn the way its conversation draws it: the
// speaker's line (a face and a name, the transcript's), then the words through
// the message markdown, so ids become pills, emphasis renders and the words
// searched for are marked inside the rendered text (HighlightContext). The
// window is the stretch the server cut around the hit; a long one clips with
// a fade rather than a hard line.
import { memo, useMemo, useRef } from "react";
import Link from "next/link";
import { HighlightContext } from "../HighlightContext";
import { MessageMarkdown } from "../conversation/markdown";
import { AssistantIcon, UserIcon } from "../conversation/blocks/shared";
import { assistantLabel } from "../../lib/conversationBlockStyles";
import { clipFade } from "../CollapsibleBody";
import { useOverflows } from "../../hooks/useOverflows";
import { formatSearchTimestamp } from "../../lib/searchTimestamp";
import { stripWrapperTags } from "@codecast/shared/search";

/** The lines a snippet shows before it clips: three reads as a passage, not a wall. */
const CLIP_PX = 76;

/** Who said a message, as its transcript's header line names them: the
 *  person's avatar and name ("You" for the viewer), or the agent's mark and
 *  name. */
export function SpeakerLine({ role, agentType, authorName, authorAvatar, isOwn }: {
  role: string; agentType?: string | null; authorName?: string | null; authorAvatar?: string | null; isOwn?: boolean;
}) {
  if (role === "user") {
    return (
      <>
        <UserIcon avatarUrl={authorAvatar} size="w-4 h-4" />
        <span className="font-medium text-sol-blue">{isOwn !== false ? "You" : authorName || "User"}</span>
      </>
    );
  }
  return (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center"><span className="scale-[0.667]"><AssistantIcon agentType={agentType ?? undefined} /></span></span>
      <span className="font-medium text-sol-text-secondary">{assistantLabel(agentType ?? undefined)}</span>
    </>
  );
}

export const MatchSnippet = memo(function MatchSnippet({ content, timestamp, who, userText, highlight, href, external, onClick, onContextMenu, clipPx = CLIP_PX }: {
  content: string;
  timestamp?: number;
  /** The speaker's line (SpeakerLine, or a chat author). */
  who: React.ReactNode;
  /** A person wrote it: the message markdown's user rules apply. */
  userText?: boolean;
  /** The words searched for (operators stripped), marked in the text. */
  highlight: string;
  href: string;
  /** The address leaves the app (a chat permalink). */
  external?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  clipPx?: number;
}) {
  const body = useMemo(() => stripWrapperTags(content), [content]);
  // The fade only where the clip cuts: a short hit keeps its last line crisp.
  const clipRef = useRef<HTMLDivElement>(null);
  const clipped = useOverflows(clipRef, clipPx, [body]);
  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-search-match
      className="group/match block rounded-md px-3 py-2 no-underline transition-colors hover:bg-sol-bg-highlight/50"
    >
      <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px]">
        {who}
        {timestamp ? <span className="flex-shrink-0 tabular-nums text-sol-text-dim">{formatSearchTimestamp(timestamp)}</span> : null}
      </div>
      <div ref={clipRef} className="overflow-hidden pl-[22px]" style={{ maxHeight: clipPx, ...(clipped ? clipFade(20) : null) }}>
        <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-sol-text-secondary [&_p]:my-0 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_pre]:my-1 [&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px]">
          <HighlightContext.Provider value={highlight || undefined}>
            <MessageMarkdown content={body} userText={userText} />
          </HighlightContext.Provider>
        </div>
      </div>
    </Link>
  );
});
