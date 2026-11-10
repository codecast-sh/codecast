import {
  Activity, AppWindow, Bell, Blocks, Brain, ChartColumn, CircleHelp, ClipboardCheck, Ellipsis, FileText, Flag,
  FlaskConical, FolderGit2, FolderKanban, Gauge, GitBranch, Globe, Inbox, KeyRound, Library, ListChecks, Map as MapIcon,
  MessageSquare, MessageSquareText, MessagesSquare, Network, Newspaper, NotebookText, Phone, Puzzle, Radar, Radio,
  Rocket, Rss, ScrollText, Search, Settings, Signpost, SlidersHorizontal, SquareTerminal, Users, Waypoints, Workflow, Zap,
  type LucideIcon,
} from "lucide-react";
import type { NavIconName } from "../../lib/navRegistry";

// A destination's icon (lib/navRegistry names it), drawn the one way the rail
// and the palette draw every page: 16px, one stroke weight. Simple view and
// Minimal resize rail icons by the data-rail-icon marker (app/globals.css).

const ICONS: Record<NavIconName, LucideIcon> = {
  Activity, AppWindow, Bell, Blocks, Brain, ChartColumn, CircleHelp, ClipboardCheck, Ellipsis, FileText, Flag,
  FlaskConical, FolderGit2, FolderKanban, Gauge, GitBranch, Globe, Inbox, KeyRound, Library, ListChecks, Map: MapIcon,
  MessageSquare, MessageSquareText, MessagesSquare, Network, Newspaper, NotebookText, Phone, Puzzle, Radar, Radio,
  Rocket, Rss, ScrollText, Search, Settings, Signpost, SlidersHorizontal, SquareTerminal, Users, Waypoints, Workflow, Zap,
};

export function RailIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon data-rail-icon="" aria-hidden className={`w-4 h-4 flex-shrink-0 ${className ?? ""}`} strokeWidth={1.75} />;
}
