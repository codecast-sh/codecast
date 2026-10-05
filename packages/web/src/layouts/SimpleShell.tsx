// The simple lane's shell (plan pl-840, docs/architecture/hosted-assistant.md
// "The simple lane"): its own layout, not DashboardLayout. A calm top bar, a
// floating tab bar on a phone, and the page. It mounts the same store
// feeders and write wiring as the dashboard (DashboardSyncEffects), minus the
// full app's window effects (call rings, chat toasts, mods), so every lane
// surface reads the store the rest of the app reads.
import { useState } from "react";
import { Link, NavLink, Outlet, useMatch, useNavigate } from "react-router";
import { ArrowLeft, CalendarClock, CircleGauge, Hand, House, LayoutGrid, Moon, MoreHorizontal, Plug, Sun } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { DashboardSyncEffects } from "@/components/DashboardLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTheme } from "@/components/ThemeProvider";
import { useInboxStore } from "@/store/inboxStore";
import { LANE_PATHS, conversationTitle } from "@/components/simple/lane";
import { useLaneData, useSetLane } from "@/components/simple/useLane";
import { useLaneFont } from "@/components/simple/useLaneFont";
import { UndoTimelineHost } from "@/components/undo/UndoTimeline";
import { useUndoWalk } from "@/hooks/useUndoWalk";
import "@/components/simple/simple.css";

const TABS = [
  { to: LANE_PATHS.home, label: "Home", icon: House, end: true },
  { to: LANE_PATHS.approvals, label: "Approvals", icon: Hand, end: false },
  { to: LANE_PATHS.routines, label: "Routines", icon: CalendarClock, end: false },
  { to: LANE_PATHS.connections, label: "Connections", icon: Plug, end: false },
  { to: LANE_PATHS.plan, label: "Plan", icon: CircleGauge, end: false },
] as const;

function LaneMenu() {
  const [open, setOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const setLane = useSetLane();
  return (
    <div style={{ position: "relative" }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button type="button" className="sl-icon-btn" aria-label="More" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={19} />
      </button>
      {open ? (
        <div className="sl-menu" role="menu">
          <button type="button" role="menuitem" className="sl-menu-item" onClick={() => { toggleTheme(); setOpen(false); }}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === "dark" ? "Light appearance" : "Dark appearance"}</span>
          </button>
          <div className="sl-menu-sep" />
          <button type="button" role="menuitem" className="sl-menu-item" onClick={() => setLane("full")}>
            <LayoutGrid size={17} />
            <span>
              Open the full app
              <small>Every tool, for people who build software</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ThreadTitle({ id }: { id: string }) {
  const title = useInboxStore((s) => {
    const live = s.resolveLiveSessionId(id);
    const row = s.sessions[live] ?? (s.conversations[live] as any);
    return conversationTitle(row);
  });
  return <span className="sl-convo-title">{title}</span>;
}

function TopBar({ approvals, threadId }: { approvals: number; threadId: string | null }) {
  const navigate = useNavigate();
  return (
    <header className="sl-top">
      {threadId ? (
        <div className="sl-convo-head">
          <button type="button" className="sl-icon-btn" aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(LANE_PATHS.home))}>
            <ArrowLeft size={19} />
          </button>
          <ThreadTitle id={threadId} />
        </div>
      ) : (
        <Link to={LANE_PATHS.home} className="sl-brand" aria-label="Home">
          <span className="sl-brand-mark" aria-hidden />
          <span>codecast</span>
        </Link>
      )}
      <nav className="sl-top-nav" aria-label="Sections">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="sl-top-link">
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
    <nav className="sl-tabs" aria-label="Sections">
      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="sl-tab">
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
  const thread = useMatch("/simple/c/:id");
  const threadId = thread?.params.id ?? null;
  return (
    <div data-simple-lane data-in-thread={threadId ? "" : undefined}>
      <div className="sl-frame">
        <TopBar approvals={approvals.length} threadId={threadId} />
        <ErrorBoundary name="SimpleLanePage" level="panel">
          <Outlet />
        </ErrorBoundary>
      </div>
      {threadId ? null : <TabBar approvals={approvals.length} />}
    </div>
  );
}

// The lane's gestures record undo history (a routine paused from its page
// takes an Undo toast), so the lane reaches it the way the dashboard does:
// ⌘Z, ⌘⇧Z and ⌘⌥Z with the held peek, and the card a toast's History opens.
function LaneUndo() {
  useUndoWalk();
  return <UndoTimelineHost />;
}

export default function SimpleShell() {
  return (
    <AuthGuard signedOutPath={LANE_PATHS.welcome}>
      <ErrorBoundary name="SimpleLaneSync" level="inline" fallback={null}>
        <DashboardSyncEffects windowEffects={false} />
      </ErrorBoundary>
      <LaneChrome />
      <LaneUndo />
    </AuthGuard>
  );
}
