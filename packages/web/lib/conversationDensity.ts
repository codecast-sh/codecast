import { useInboxStore, resolveSimpleView } from "../store/inboxStore";
import { AlignJustify, ListCollapse, GalleryVerticalEnd, GitCommitVertical, BookOpenText } from "lucide-react";
import type { ConversationDensity, MessageFeedDensity } from "../components/conversation/types";

export const FEED_DENSITY_CYCLE: MessageFeedDensity[] = ["full", "condensed", "compact"];

// Last-chosen density per conversation, app-session scoped.
export const DENSITY_BY_CONVERSATION = new Map<string, ConversationDensity>();

// Simple view reads calmer by default: tool activity as one-line receipts.
// An explicit per-conversation choice (the map above) still wins.
export function defaultDensity(): ConversationDensity {
  return resolveSimpleView(useInboxStore.getState().clientState.ui) ? "condensed" : "full";
}

export const DENSITY_OPTIONS: Array<{ value: ConversationDensity; label: string; description: string; icon: React.ComponentType<{ className?: string }>; ai?: boolean }> = [
  { value: "full", label: "Full", description: "Everything as it happened", icon: AlignJustify },
  { value: "condensed", label: "Condensed", description: "Tool activity as one-line receipts", icon: ListCollapse },
  { value: "compact", label: "Compact", description: "Condensed, plus long replies clipped to their ending", icon: GalleryVerticalEnd },
  { value: "story", label: "Story", description: "A timeline retelling, each reply condensed in its own voice", icon: GitCommitVertical, ai: true },
  { value: "summary", label: "Summary", description: "One short narrative of the whole session", icon: BookOpenText, ai: true },
];
