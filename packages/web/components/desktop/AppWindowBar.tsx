"use client";
// The header of an app window (Chat, Work): the traffic-light inset, the
// app's name, and its sections as tabs. It replaces the dashboard's top bar,
// tab strip and rails in that window, so the window reads as one small app
// rather than a copy of the whole dashboard with the chrome switched off.
//
// It is also the window's titlebar: the row is the drag region and indents
// past the macOS lights (desktopHeaderClass), the way the top bar does in
// the main window; its links are no-drag by the same stylesheet rule.
import Link from "next/link";
import { Layers, MessageSquare, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { useShortcutAction } from "../../shortcuts";
import { useChatUnread } from "../../hooks/useChatSync";
import { desktopHeaderClass } from "../../lib/desktop";
import { DESKTOP_APPS, sectionForRoute, type DesktopApp } from "../../lib/desktopApps";
import { cn } from "../../lib/utils";

function SectionTab({ href, label, active, badge }: { href: string; label: string; active: boolean; badge?: React.ReactNode }) {
  return (
    <Link
      href={href}
      data-app-section={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors",
        active ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text",
      )}
    >
      {label}
      {badge}
    </Link>
  );
}

/** The Chat tab's unread mark: mentions as a count, plain unread as a dot. */
function ChatBadge() {
  const { channels, mentions } = useChatUnread();
  if (mentions > 0) {
    return (
      <span
        className="min-w-[16px] rounded-full bg-sol-red px-1 text-center text-[10px] font-semibold leading-4 text-white"
        aria-label={`${mentions} mentions`}
      >
        {mentions > 99 ? "99+" : mentions}
      </span>
    );
  }
  if (channels > 0) return <span className="h-1.5 w-1.5 rounded-full bg-sol-cyan" aria-label="Unread messages" />;
  return null;
}

// The app's glyph beside its name. Here rather than in the route table,
// which the shell loads too and must stay free of the DOM.
const APP_ICON: Record<DesktopApp, LucideIcon> = { chat: MessageSquare, work: Layers };

export function AppWindowBar({ app }: { app: DesktopApp }) {
  const spec = DESKTOP_APPS[app];
  const pathname = usePathname() ?? "";
  const active = sectionForRoute(app, pathname);
  const Icon = APP_ICON[app];
  const router = useRouter();
  // The sections are this window's tabs, so the tab chords walk them. The
  // tab strip declines those chords in a detached window (it draws no strip
  // there), which is what lets these handlers take them.
  const step = useCallback(
    (by: number) => {
      const n = spec.sections.length;
      const at = spec.sections.findIndex((s) => s.path === active?.path);
      const next = spec.sections[((at < 0 ? 0 : at) + by + n) % n];
      router.push(next.path);
    },
    [spec, active?.path, router],
  );
  useShortcutAction("tab.next", useCallback(() => step(1), [step]));
  useShortcutAction("tab.prev", useCallback(() => step(-1), [step]));
  return (
    <header
      data-cc-appbar={app}
      className={cn(
        "relative z-[100] flex flex-shrink-0 items-center gap-1 border-b border-black/10 bg-sol-bg px-2 py-1.5",
        desktopHeaderClass(),
      )}
    >
      {/* The name is the window's identity, not a control: it stays part of
          the drag surface, set apart from the tabs by a hairline. */}
      <span className="flex select-none items-center gap-1.5 pl-1 pr-1 text-[13px] font-semibold tracking-tight text-sol-text">
        <Icon className="h-3.5 w-3.5 text-sol-cyan" strokeWidth={2} aria-hidden />
        {spec.title}
      </span>
      <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-sol-border" />
      <nav aria-label={`${spec.title} sections`} className="flex items-center gap-0.5">
        {spec.sections.map((s) => (
          <SectionTab
            key={s.path}
            href={s.path}
            label={s.label}
            active={active?.path === s.path}
            badge={app === "chat" && s.path === "/chat" ? <ChatBadge /> : undefined}
          />
        ))}
      </nav>
    </header>
  );
}
