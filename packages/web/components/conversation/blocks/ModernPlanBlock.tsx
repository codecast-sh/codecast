import { toast } from "sonner";
import { Bookmark, ClipboardList, Copy, Forward, Link2 } from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { copyToClipboard } from "../../../lib/utils";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE } from "../../messageMarkdown";
import { isConvexId } from "../../../store/inboxStore";
import { useMessageBookmark } from "../../../hooks/useMessageBookmark";
import { useTeamFeature } from "../../../lib/teamFeatures";
import { copyMessageLink, formatRelativeTime, forwardMessageToChat } from "../../../lib/conversationFormat";
import { Button } from "../../ui/button";
import { ReactMarkdown } from "../markdown";
import { ModernQuietBlock } from "./ModernQuietBlock";

/**
 * A plan (a plan file the agent wrote, or a plan row) in the Modern style: a
 * quiet block headed "Plan" with its title and age, the plan itself on the
 * tinted panel at the reading size, held to a sensible height with "Show
 * all". Copy, the link, chat and the bookmark sit at the panel's foot as 28px
 * ghost buttons. Folded in the compact feed.
 */
export function ModernPlanBlock({ content, timestamp, collapsed, messageId, conversationId }: {
  content: string;
  timestamp: number;
  collapsed?: boolean;
  messageId?: string;
  conversationId?: Id<"conversations">;
}) {
  const { isBookmarked, toggleBookmark } = useMessageBookmark(conversationId, messageId);
  const chatOn = useTeamFeature("chat");
  const title = content.match(/^#\s+(.+)$/m)?.[1];
  const realId = !!messageId && isConvexId(messageId);
  const copy = () => setTimeout(() => { copyToClipboard(content).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  const action = (label: string, icon: React.ReactNode, onClick: () => void, pressed?: boolean) => (
    <Button type="button" size="icon-sm" variant="ghost" title={label} aria-label={label} aria-pressed={pressed} onClick={onClick}>{icon}</Button>
  );
  return (
    <ModernQuietBlock
      family="plan"
      icon={ClipboardList}
      label="Plan"
      text={title}
      status={formatRelativeTime(timestamp)}
      defaultOpen={!collapsed}
      watch={content}
      footer={
        <>
          {action("Copy", <Copy aria-hidden />, copy)}
          {messageId && action("Copy link", <Link2 aria-hidden />, () => copyMessageLink(conversationId, messageId))}
          {chatOn && messageId && action("Send to chat", <Forward aria-hidden />, () => forwardMessageToChat(conversationId, messageId))}
          {realId && conversationId && action(isBookmarked ? "Remove bookmark" : "Bookmark", <Bookmark aria-hidden fill={isBookmarked ? "currentColor" : "none"} />, toggleBookmark, isBookmarked)}
        </>
      }
    >
      <div data-cc-prose className="text-sol-text prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </div>
    </ModernQuietBlock>
  );
}
