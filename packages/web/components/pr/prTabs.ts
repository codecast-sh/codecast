import { FileDiff, GitCommitHorizontal, ListChecks, MessagesSquare, type LucideIcon } from "lucide-react";
import type { PrView } from "../../lib/prView";

/** The tab bar's height: file headers and link targets land just under it. */
export const TAB_BAR_PX = 41;

/** The pull request page's views, in tab order, each with its number key. */
export const PR_TABS: { key: PrView; label: string; icon: LucideIcon; digit: string }[] = [
  { key: "conversation", label: "Conversation", icon: MessagesSquare, digit: "1" },
  { key: "files", label: "Files", icon: FileDiff, digit: "2" },
  { key: "commits", label: "Commits", icon: GitCommitHorizontal, digit: "3" },
  { key: "checks", label: "Checks", icon: ListChecks, digit: "4" },
];
