"use client";

/**
 * The strip at the far left of the main window: one tile per space
 * (lib/navSpaces). The tile you are in is lit; the sidebar column beside it
 * lists that space's rows. A tile opens the page you last had open in that
 * space, so moving between Chat and Work keeps your place in each; pressing
 * the lit tile goes back to the space's front page.
 *
 * The counts that matter from anywhere ride the tiles: what waits on you on
 * Home, mentions (or an unread dot) on Chat. Each is its own component, so a
 * heartbeat re-renders one badge, never the strip.
 */

import { memo, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bot, Inbox, MessageSquare } from "lucide-react";
import { TasksNavIcon } from "./navIcons";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useNeedsInputCount } from "../../hooks/useNeedsInputCount";
import { chatUnreadTotals, useChatRail } from "../../hooks/useChatSync";
import { useTeamFeature } from "../../lib/teamFeatures";
import { NAV_SPACE_LANDING, navSpaceFor, type NavSpace } from "../../lib/navSpaces";

/** The page last open in each space, for this window's lifetime. */
const lastPathBySpace: Partial<Record<NavSpace, string>> = {};

const HomeBadge = memo(function HomeBadge() {
  const n = useNeedsInputCount();
  return n > 0 ? <TileCount n={n} tone="bg-teal-600 text-white" label={`${n} waiting on you`} /> : null;
});

const ChatBadge = memo(function ChatBadge() {
  const { channels, mentions } = chatUnreadTotals(useChatRail());
  if (mentions > 0) return <TileCount n={mentions} tone="bg-sol-red text-white" label={`${mentions} mentions`} />;
  if (channels > 0) {
    return (
      <span
        className="absolute top-1.5 right-2.5 w-2 h-2 rounded-full bg-sol-cyan ring-2 ring-[var(--cc-space-rail-bg)]"
        aria-label="Unread messages"
      />
    );
  }
  return null;
});

function TileCount({ n, tone, label }: { n: number; tone: string; label: string }) {
  return (
    <span
      aria-label={label}
      className={`absolute top-0.5 right-1 min-w-[16px] h-[15px] px-1 rounded-full text-[9.5px] font-bold tabular-nums flex items-center justify-center ring-2 ring-[var(--cc-space-rail-bg)] ${tone}`}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

function Tile({
  space,
  current,
  label,
  icon,
  badge,
  onOpen,
}: {
  space: NavSpace;
  current: NavSpace;
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  onOpen: (space: NavSpace) => void;
}) {
  const on = space === current;
  return (
    <button
      type="button"
      onClick={() => onOpen(space)}
      aria-current={on ? "page" : undefined}
      data-space={space}
      className={`relative w-12 flex flex-col items-center gap-0.5 pt-1.5 pb-1 rounded-lg text-[9.5px] leading-none transition-colors motion-reduce:transition-none ${
        on
          ? "bg-sol-bg text-sol-text shadow-[0_1px_0_var(--sol-border)]"
          : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight/60"
      }`}
    >
      <span className="w-5 h-5 grid place-items-center">{icon}</span>
      <span className={on ? "font-semibold" : ""}>{label}</span>
      {badge}
    </button>
  );
}

export function SpaceRail() {
  const pathname = usePathname();
  const router = useRouter();
  const current = navSpaceFor(pathname);
  const chatOn = useTeamFeature("chat");

  useWatchEffect(() => {
    if (pathname) lastPathBySpace[navSpaceFor(pathname)] = pathname;
  }, [pathname]);

  const open = (space: NavSpace) => {
    const target = space === current ? NAV_SPACE_LANDING[space] : lastPathBySpace[space] ?? NAV_SPACE_LANDING[space];
    if (target !== pathname) router.push(target);
  };

  return (
    <nav
      aria-label="Spaces"
      data-cc-space-rail
      className="w-[60px] flex-shrink-0 flex flex-col items-center gap-1 py-2 border-r border-sol-border/30 bg-[var(--cc-space-rail-bg)] [--cc-space-rail-bg:color-mix(in_srgb,var(--sol-bg-alt)_82%,var(--sol-border))] select-none"
    >
      <Tile space="home" current={current} label="Home" icon={<Inbox className="w-5 h-5" strokeWidth={1.5} />} badge={<HomeBadge />} onOpen={open} />
      {chatOn && (
        <Tile space="chat" current={current} label="Chat" icon={<MessageSquare className="w-5 h-5" strokeWidth={1.5} />} badge={<ChatBadge />} onOpen={open} />
      )}
      <Tile space="work" current={current} label="Work" icon={<TasksNavIcon />} onOpen={open} />
      <Tile space="agents" current={current} label="Agents" icon={<Bot className="w-5 h-5" strokeWidth={1.5} />} onOpen={open} />
    </nav>
  );
}
