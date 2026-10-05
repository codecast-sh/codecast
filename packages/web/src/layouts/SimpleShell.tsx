// The simple lane's shell (plan pl-840, docs/architecture/hosted-assistant.md
// "The simple lane"): its own layout, not DashboardLayout. A calm top bar, a
// floating tab bar on a phone, and the page. It mounts the same store
// feeders and write wiring as the dashboard (LaneSync), so every lane surface
// reads the store the rest of the app reads.
import { Link, NavLink, Outlet, useMatch, useNavigate } from "react-router";
import { ArrowLeft, CalendarClock, CircleGauge, Hand, House, LayoutGrid, Moon, MoreHorizontal, Plug, Sun } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/ThemeProvider";
import { LANE_CONVERSATION_ROUTE, LANE_COPY, LANE_PATHS, LANE_SECTIONS, type LaneSectionKey } from "@/components/simple/lane";
import { useLaneConversationTitle, useLaneDocumentTitle } from "@/components/simple/useLaneTitle";
import { useLaneData } from "@/components/simple/useLane";
import { useSetLane } from "@/components/simple/useSetLane";
import { useLaneFont } from "@/components/simple/useLaneFont";
import { LaneSync } from "@/components/simple/LaneSync";
import { UndoReach } from "@/components/undo/UndoTimeline";
import { useLaneUndoFrame } from "@/components/simple/useLaneUndoFrame";
import "@/components/simple/simple.css";

const ICONS: Record<LaneSectionKey, typeof House> = { home: House, approvals: Hand, routines: CalendarClock, connections: Plug, plan: CircleGauge };

const TABS = LANE_SECTIONS.map((t) => ({ to: t.path, label: t.label, icon: ICONS[t.key], end: t.key === "home" }));

function LaneMenu() {
  const { theme, toggleTheme } = useTheme();
  const setLane = useSetLane();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="sl-icon-btn" aria-label={LANE_COPY.menu.more}>
          <MoreHorizontal size={19} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="sl-menu">
        <DropdownMenuItem className="sl-menu-item" onSelect={() => toggleTheme()}>
          {theme === "dark" ? <Sun /> : <Moon />}
          <span>{theme === "dark" ? LANE_COPY.menu.light : LANE_COPY.menu.dark}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="sl-menu-sep" />
        <DropdownMenuItem className="sl-menu-item" onSelect={() => setLane("full")}>
          <LayoutGrid />
          <span>
            {LANE_COPY.menu.full}
            <small>{LANE_COPY.menu.fullNote}</small>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({ approvals, threadId, threadTitle }: { approvals: number; threadId: string | null; threadTitle: string | null }) {
  const navigate = useNavigate();
  return (
    <header className="sl-top">
      {threadId ? (
        <div className="sl-convo-head">
          <button type="button" className="sl-icon-btn" aria-label={LANE_COPY.conversation.back} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(LANE_PATHS.home))}>
            <ArrowLeft size={19} />
          </button>
          <span className="sl-convo-title">{threadTitle}</span>
        </div>
      ) : (
        <Link to={LANE_PATHS.home} className="sl-brand" aria-label={LANE_COPY.menu.home}>
          <span className="sl-brand-mark" aria-hidden />
          <span>codecast</span>
        </Link>
      )}
      <nav className="sl-top-nav" aria-label={LANE_COPY.tabs.sections}>
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="sl-top-link" aria-label={LANE_COPY.tabs.label(t.label, t.to === LANE_PATHS.approvals ? approvals : 0)}>
            {t.label}
            {t.to === LANE_PATHS.approvals && approvals > 0 ? <span className="sl-badge">{approvals}</span> : null}
          </NavLink>
        ))}
      </nav>
      <div className="sl-top-tools">
        <LaneMenu />
      </div>
    </header>
  );
}

function TabBar({ approvals }: { approvals: number }) {
  return (
    <nav className="sl-tabs" aria-label={LANE_COPY.tabs.sections}>
      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="sl-tab" aria-label={LANE_COPY.tabs.label(label, to === LANE_PATHS.approvals ? approvals : 0)}>
          <Icon size={20} strokeWidth={1.9} />
          <span>{label}</span>
          {to === LANE_PATHS.approvals && approvals > 0 ? <span className="sl-badge">{approvals}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

function LaneChrome() {
  useLaneFont();
  const { approvals } = useLaneData();
  const thread = useMatch(LANE_CONVERSATION_ROUTE);
  const threadId = thread?.params.id ?? null;
  const threadTitle = useLaneConversationTitle(threadId);
  useLaneDocumentTitle(threadTitle);
  return (
    <div data-simple-lane data-in-thread={threadId ? "" : undefined}>
      <div className="sl-frame">
        <TopBar approvals={approvals.length} threadId={threadId} threadTitle={threadTitle} />
        <ErrorBoundary name="SimpleLanePage" level="panel">
          <Outlet />
        </ErrorBoundary>
      </div>
      {threadId ? null : <TabBar approvals={approvals.length} />}
    </div>
  );
}

export default function SimpleShell() {
  const undoFrame = useLaneUndoFrame();
  return (
    <AuthGuard signedOutPath={LANE_PATHS.welcome}>
      <LaneSync />
      <LaneChrome />
      {/* The lane's gestures record undo history (a routine paused from its
          page takes an Undo toast), so the lane reaches it the way the
          dashboard does. */}
      <UndoReach frame={undoFrame} />
    </AuthGuard>
  );
}
