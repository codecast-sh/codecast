"use client";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import {
  Send, Fingerprint, Quote, Star, BookOpen, Gauge, MonitorSmartphone, RefreshCw,
  ListFilter, FolderKanban, AppWindow, Share2, Users, Wrench, ListChecks, Workflow,
  Globe, FileText, Activity, Server, Inbox, Smartphone, GitBranch, Monitor, Brain,
  Github, Cpu, LayoutDashboard, Boxes, Puzzle, Laptop, Cloud,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { RELEASES, type Accent, type SectionIcon } from "./changelogData";

const SOL = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
};

const ACCENT: Record<Accent, string> = {
  blue: SOL.blue,
  cyan: SOL.cyan,
  green: SOL.green,
  violet: SOL.violet,
  yellow: SOL.yellow,
  orange: SOL.orange,
  magenta: SOL.magenta,
  red: SOL.red,
};

const ICONS: Record<SectionIcon, LucideIcon> = {
  Send, Fingerprint, Quote, Star, BookOpen, Gauge, MonitorSmartphone, RefreshCw,
  ListFilter, FolderKanban, AppWindow, Share2, Users, Wrench, ListChecks, Workflow,
  Globe, FileText, Activity, Server, Inbox, Smartphone, GitBranch, Monitor, Brain,
  Github, Cpu, LayoutDashboard, Boxes, Puzzle,
};

// Marker colors cycle down the timeline so the spine has rhythm. Order is
// chosen so adjacent dots never repeat.
const DOT_CYCLE: Accent[] = ["cyan", "blue", "violet", "green", "yellow", "orange", "magenta"];

/** Render a highlight string, turning `backtick` spans into inline code. */
function Inline({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="px-1.5 py-0.5 rounded text-[0.85em] font-mono"
            style={{ backgroundColor: SOL.base2, color: SOL.base03 }}
          >
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

// A handful of tileable SVG motifs. Each section's header picks one
// deterministically, so a card's cover stays stable across renders but the
// page as a whole has visual variety. `currentColor` lets the accent flow in.
const PATTERN_COUNT = 5;
function PatternTile({ id, kind }: { id: string; kind: number }) {
  switch (((kind % PATTERN_COUNT) + PATTERN_COUNT) % PATTERN_COUNT) {
    case 0: // dot grid
      return (
        <pattern id={id} width="15" height="15" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.1" fill="currentColor" />
        </pattern>
      );
    case 1: // line grid
      return (
        <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0v20" fill="none" stroke="currentColor" strokeWidth="0.8" />
        </pattern>
      );
    case 2: // diagonal hatch
      return (
        <pattern id={id} width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.1" />
        </pattern>
      );
    case 3: // concentric rings
      return (
        <pattern id={id} width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="13" cy="13" r="9" fill="none" stroke="currentColor" strokeWidth="0.9" />
        </pattern>
      );
    default: // plus marks
      return (
        <pattern id={id} width="22" height="22" patternUnits="userSpaceOnUse">
          <path d="M11 6v10 M6 11h10" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
        </pattern>
      );
  }
}

/** Generated cover banner for a section: accent gradient + pattern + a large
 *  icon watermark, with a solid icon badge overlapping the seam below. */
function SectionHeader({ ac, Icon, kind, uid }: { ac: string; Icon: LucideIcon; kind: number; uid: string }) {
  const pid = `cl-pat-${uid}`;
  return (
    <div
      className="relative h-20"
      style={{
        background: `linear-gradient(135deg, ${ac}2b 0%, ${ac}0d 55%, ${SOL.base2}00 100%)`,
        borderBottom: `1px solid ${ac}20`,
      }}
    >
      {/* pattern + watermark, clipped to the banner */}
      <div className="absolute inset-0 overflow-hidden">
        <svg className="absolute inset-0 w-full h-full" style={{ color: ac, opacity: 0.4 }} aria-hidden>
          <defs>
            <PatternTile id={pid} kind={kind} />
          </defs>
          <rect width="100%" height="100%" fill={`url(#${pid})`} />
        </svg>
        <Icon
          className="absolute -right-3 -bottom-4 w-[88px] h-[88px]"
          style={{ color: ac, opacity: 0.16 }}
          strokeWidth={1}
          aria-hidden
        />
      </div>
      {/* icon badge overlapping the bottom edge */}
      <span
        className="absolute left-4 -bottom-4 flex items-center justify-center w-9 h-9 rounded-lg"
        style={{
          background: ac,
          color: SOL.base3,
          boxShadow: `0 0 0 3px ${SOL.base3}, 0 2px 8px ${ac}55`,
        }}
        aria-hidden
      >
        <Icon className="w-[18px] h-[18px]" strokeWidth={2} />
      </span>
    </div>
  );
}

// Per-month hero — a realistic mock of that month's headline feature, framed
// like a product screenshot in the app's dark theme (which pops on the cream
// page). Built from live HTML, so it's crisp at any size and the month accent
// threads through. Dark Solarized colors are hardcoded since the marketing page
// is forced light.
const INK = "#00212b"; // a touch darker than base03, for code wells
const SCENE_H = 190;

function Dot({ c }: { c: string }) {
  return <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c }} />;
}
function Pill({ c, children }: { c: string; children: React.ReactNode }) {
  return (
    <span
      className="text-[9px] font-mono px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap"
      style={{ backgroundColor: `${c}24`, color: c }}
    >
      {children}
    </span>
  );
}
function Avatar({ c, initials }: { c: string; initials: string }) {
  return (
    <span
      className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[8px] font-bold shrink-0"
      style={{ backgroundColor: c, color: SOL.base03 }}
    >
      {initials}
    </span>
  );
}

function monthMock(id: string, ac: string) {
  switch (id) {
    case "2026-06": // messaging + comments
      return (
        <div className="flex h-full">
          <div className="flex-1 min-w-0 p-3.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <Avatar c={ac} initials="AI" />
              <span className="text-[11px]" style={{ color: SOL.base0 }}>Assistant</span>
              <span className="text-[10px]" style={{ color: SOL.base01 }}>· just now</span>
            </div>
            <p className="text-[12px] leading-relaxed" style={{ color: SOL.base1 }}>
              I&apos;ll cache the session list in the store so the inbox renders instantly instead of refetching on every open.
            </p>
            <div className="rounded-md px-2.5 py-1.5 text-[10.5px] font-mono truncate" style={{ backgroundColor: SOL.base02, color: SOL.base0 }}>
              keepOnScreen + liveInboxIds
            </div>
          </div>
          <div className="w-[150px] shrink-0 p-3 space-y-2" style={{ borderLeft: `1px solid ${SOL.base02}`, backgroundColor: `${SOL.base02}66` }}>
            <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: SOL.base01 }}>Comments</div>
            <div className="flex items-start gap-1.5">
              <Avatar c={SOL.magenta} initials="SA" />
              <p className="text-[11px] leading-snug" style={{ color: SOL.base1 }}>
                <span style={{ color: SOL.base0 }}>sam</span> can we memoize this?
              </p>
            </div>
          </div>
        </div>
      );
    case "2026-05": { // devices
      const rows = [
        { Icon: Laptop, name: "MacBook Pro", meta: "local", st: "online", sc: SOL.green },
        { Icon: Cloud, name: "cloud-vm-1", meta: "us-east", st: "active", sc: SOL.cyan },
        { Icon: Server, name: "mac-mini-01", meta: "office", st: "online", sc: SOL.green },
        { Icon: Cpu, name: "sandbox-7f3", meta: "ephemeral", st: "idle", sc: SOL.base01 },
      ];
      return (
        <div className="p-3 h-full">
          <div className="flex items-center gap-2 px-1 pb-1.5">
            <MonitorSmartphone className="w-3.5 h-3.5" style={{ color: SOL.base0 }} />
            <span className="text-[12px] font-medium" style={{ color: SOL.base2 }}>Devices</span>
          </div>
          <div className="space-y-1">
            {rows.map((r) => (
              <div key={r.name} className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5">
                <r.Icon className="w-4 h-4 shrink-0" style={{ color: ac }} />
                <span className="flex-1 truncate text-[12px] font-mono" style={{ color: SOL.base1 }}>{r.name}</span>
                <span className="text-[10px]" style={{ color: SOL.base01 }}>{r.meta}</span>
                <Dot c={r.sc} />
                <span className="text-[10px] w-10" style={{ color: r.sc }}>{r.st}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "2026-04": // workspaces, tabs, windows
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-stretch gap-1 px-2 pt-2" style={{ backgroundColor: SOL.base02 }}>
            {["Fix auth redirect", "Stripe webhooks", "+ new"].map((t, i) => (
              <div
                key={t}
                className="px-2.5 py-1.5 rounded-t-md text-[11px] truncate max-w-[120px]"
                style={{
                  backgroundColor: i === 0 ? SOL.base03 : "transparent",
                  color: i === 0 ? SOL.base2 : SOL.base01,
                  borderTop: `2px solid ${i === 0 ? ac : "transparent"}`,
                }}
              >
                {t}
              </div>
            ))}
          </div>
          <div className="flex flex-1 min-h-0">
            <div className="w-28 shrink-0 p-2.5 space-y-1.5 text-[11px]" style={{ borderRight: `1px solid ${SOL.base02}` }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: SOL.base01 }}>Projects</div>
              {["codecast", "web", "mobile"].map((p, i) => (
                <div key={p} className="flex items-center gap-1.5 truncate" style={{ color: i === 0 ? ac : SOL.base0 }}>
                  <FolderKanban className="w-3 h-3 shrink-0" /> {p}
                </div>
              ))}
            </div>
            <div className="flex-1 p-3.5 space-y-2.5">
              <div className="text-[12px]" style={{ color: SOL.base1 }}>Fix auth redirect loop</div>
              {["85%", "62%", "73%"].map((w, i) => (
                <span key={i} className="block h-1.5 rounded-full" style={{ width: w, backgroundColor: SOL.base02 }} />
              ))}
            </div>
          </div>
        </div>
      );
    case "2026-03": { // plans + orchestration
      const tasks = [
        { name: "Stripe checkout flow", st: "done", sc: SOL.green },
        { name: "Webhook verification", st: "done", sc: SOL.green },
        { name: "Subscription model", st: "in progress", sc: SOL.blue },
        { name: "Billing page UI", st: "blocked", sc: SOL.red },
      ];
      return (
        <div className="p-3.5 h-full">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[13px] font-medium" style={{ color: SOL.base2 }}>Add payments</span>
            <Pill c={ac}>active</Pill>
          </div>
          <div className="text-[10px] mb-2" style={{ color: SOL.base01 }}>2 of 4 tasks done</div>
          <div className="h-1.5 rounded-full mb-3.5 overflow-hidden" style={{ backgroundColor: SOL.base02 }}>
            <div className="h-full rounded-full" style={{ width: "50%", backgroundColor: ac }} />
          </div>
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.name} className="flex items-center gap-2.5">
                <Dot c={t.sc} />
                <span className="flex-1 truncate text-[12px]" style={{ color: SOL.base1 }}>{t.name}</span>
                <Pill c={t.sc}>{t.st}</Pill>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "2026-02": { // inbox
      const rows = [
        { sc: SOL.green, title: "Fix auth redirect loop", agent: "opus", t: "2m" },
        { sc: SOL.yellow, title: "Stripe webhook retries", agent: "codex", t: "14m" },
        { sc: SOL.base01, title: "Refactor inbox store", agent: "opus", t: "1h" },
        { sc: SOL.green, title: "Add dark mode toggle", agent: "opus", t: "3h" },
      ];
      return (
        <div className="p-3 h-full">
          <div className="flex items-center gap-2 px-1 pb-1.5">
            <Inbox className="w-3.5 h-3.5" style={{ color: SOL.base0 }} />
            <span className="text-[12px] font-medium" style={{ color: SOL.base2 }}>Inbox</span>
            <span className="text-[10px]" style={{ color: SOL.base01 }}>4 sessions</span>
          </div>
          <div className="space-y-1">
            {rows.map((r, i) => (
              <div
                key={r.title}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5"
                style={{
                  backgroundColor: i === 0 ? SOL.base02 : "transparent",
                  boxShadow: i === 0 ? `inset 0 0 0 1px ${ac}55` : undefined,
                }}
              >
                <Dot c={r.sc} />
                <span className="flex-1 truncate text-[12px]" style={{ color: SOL.base1 }}>{r.title}</span>
                <Pill c={SOL.base0}>{r.agent}</Pill>
                <span className="text-[10px] tabular-nums w-6 text-right" style={{ color: SOL.base01 }}>{r.t}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "2026-01": // memory / CLI search
      return (
        <div className="p-3.5 h-full font-mono text-[11px] leading-relaxed" style={{ color: SOL.base1 }}>
          <div><span style={{ color: SOL.green }}>$ </span>cast ask <span style={{ color: SOL.cyan }}>&quot;why did we pick Convex?&quot;</span></div>
          <div style={{ color: SOL.base01 }}>↳ searching 847 sessions…</div>
          <div className="mt-1.5">Live queries and a reactive cache, so the inbox</div>
          <div>updates without manual refetching.</div>
          <div className="mt-2.5 rounded-md px-2.5 py-1.5 flex items-center gap-2" style={{ backgroundColor: SOL.base02 }}>
            <span style={{ color: ac }}>jx74qbm</span>
            <span className="flex-1 truncate" style={{ color: SOL.base0 }}>Pick a backend</span>
            <span style={{ color: SOL.base01 }}>Jan 12</span>
          </div>
        </div>
      );
    case "2025-12": // conversation viewer
    default:
      return (
        <div className="p-3.5 h-full space-y-2">
          <div className="flex items-center gap-2">
            <Avatar c={ac} initials="AI" />
            <span className="text-[11px]" style={{ color: SOL.base0 }}>Assistant</span>
          </div>
          <p className="text-[12px]" style={{ color: SOL.base1 }}>Here&apos;s the auth callback handler:</p>
          <div className="rounded-md p-2.5 font-mono text-[10.5px] leading-relaxed" style={{ backgroundColor: INK, border: `1px solid ${SOL.base02}`, color: SOL.base0 }}>
            <div><span style={{ color: SOL.violet }}>export function</span> <span style={{ color: SOL.blue }}>handleCallback</span>() {"{"}</div>
            <div className="pl-3"><span style={{ color: SOL.violet }}>const</span> token = <span style={{ color: SOL.cyan }}>await</span> exchange(code);</div>
            <div className="pl-3"><span style={{ color: SOL.violet }}>return</span> redirect(<span style={{ color: SOL.green }}>&quot;/inbox&quot;</span>);</div>
            <div>{"}"}</div>
          </div>
          <div className="flex items-center gap-2 text-[10px]" style={{ color: SOL.base01 }}>
            <FileText className="w-3 h-3" /> Read src/auth/callback.ts
          </div>
        </div>
      );
  }
}

function MonthHero({ id, ac, label }: { id: string; ac: string; label: string }) {
  return (
    <div
      className="w-full rounded-xl overflow-hidden mb-7"
      style={{ border: `1px solid ${SOL.base2}`, boxShadow: `0 12px 32px ${SOL.base01}1f` }}
      role="img"
      aria-label={`${label} — interface preview`}
    >
      {/* window title bar */}
      <div className="flex items-center gap-1.5 px-3 py-2" style={{ backgroundColor: SOL.base2 }}>
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: `${SOL.red}99` }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: `${SOL.yellow}99` }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: `${SOL.green}99` }} />
        <span className="ml-2 text-[10px] font-mono" style={{ color: SOL.base01 }}>codecast.sh</span>
      </div>
      {/* dark app interior */}
      <div className="overflow-hidden" style={{ height: SCENE_H, backgroundColor: SOL.base03 }}>
        {monthMock(id, ac)}
      </div>
    </div>
  );
}

export default function ChangelogPage() {
  const [activeId, setActiveId] = useState(RELEASES[0]?.id ?? "");

  // Scroll-spy: highlight the month in the rail that's nearest the top.
  useMountEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-72px 0px -65% 0px", threshold: 0 }
    );
    RELEASES.forEach((r) => {
      const el = document.getElementById(r.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  });

  return (
    <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
      {/* Reveal + selection styling, scoped to this page. Holds at opacity 1 so
          content is never permanently hidden, and disables under reduced motion. */}
      <style>{`
        @keyframes cl-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        .cl-rise { animation: cl-rise .55s cubic-bezier(.21,.6,.35,1) both; }
        .cl-card {
          border: 1px solid ${SOL.base2};
          transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease;
        }
        .cl-card:hover {
          border-color: color-mix(in srgb, var(--ac) 45%, ${SOL.base2});
          transform: translateY(-2px);
          box-shadow: 0 8px 24px ${SOL.base01}1f;
        }
        @media (prefers-reduced-motion: reduce) {
          .cl-rise { animation: none !important; opacity: 1 !important; transform: none !important; }
          .cl-card { transition: none; }
          .cl-card:hover { transform: none; }
        }
      `}</style>

      {/* Nav — matches the documentation page */}
      <nav
        className="backdrop-blur-sm sticky top-0 z-50"
        style={{ borderBottom: `1px solid ${SOL.base2}`, backgroundColor: "rgba(253,246,227,0.85)" }}
      >
        <div className="max-w-[90rem] mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/">
              <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
            </Link>
            <div className="hidden md:flex items-center gap-1">
              <span style={{ color: SOL.base01 }}>/</span>
              <span className="font-mono text-sm font-medium" style={{ color: SOL.base03 }}>
                changelog
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/documentation" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
              Docs
            </Link>
            <Link href="/features" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
              CLI
            </Link>
            <Link href="/signup">
              <Button className="font-medium text-white text-sm" style={{ backgroundColor: SOL.base03 }}>
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-[90rem] mx-auto flex">
        {/* Month rail */}
        <aside
          className="hidden lg:block w-56 shrink-0 sticky top-[53px] h-[calc(100vh-53px)] overflow-y-auto py-10 pl-6 pr-4"
          style={{ borderRight: `1px solid ${SOL.base2}` }}
        >
          <div className="text-[11px] font-mono uppercase tracking-wider mb-3" style={{ color: SOL.base01 }}>
            Releases
          </div>
          <nav className="space-y-0.5">
            {RELEASES.map((r) => {
              const active = activeId === r.id;
              return (
                <a
                  key={r.id}
                  href={`#${r.id}`}
                  className="flex items-center gap-2.5 py-1.5 text-sm transition-colors"
                  style={{ color: active ? SOL.blue : SOL.base00 }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0 transition-all"
                    style={{
                      backgroundColor: active ? SOL.blue : SOL.base1,
                      boxShadow: active ? `0 0 0 3px ${SOL.blue}22` : undefined,
                    }}
                  />
                  <span className="font-medium">{r.month}</span>
                </a>
              );
            })}
          </nav>
        </aside>

        {/* Timeline */}
        <div className="flex-1 min-w-0 max-w-4xl px-6 lg:px-12 py-10 pb-32">
          {/* Hero */}
          <header className="mb-14 cl-rise">
            <h1 className="text-4xl font-bold font-mono mb-4" style={{ color: SOL.base03 }}>
              Changelog
            </h1>
            <p className="text-lg leading-relaxed max-w-2xl" style={{ color: SOL.base00 }}>
              What we shipped, month by month. Newest first.
            </p>
          </header>

          {/* Spine + entries */}
          <div className="relative">
            {/* the vertical line */}
            <div
              className="absolute top-1 bottom-1 w-px"
              style={{
                left: 5,
                background: `linear-gradient(to bottom, ${SOL.base1}, ${SOL.base2} 92%, transparent)`,
              }}
              aria-hidden
            />

            {RELEASES.map((r, ri) => {
              const dot = ACCENT[DOT_CYCLE[ri % DOT_CYCLE.length]];
              return (
                <section
                  key={r.id}
                  id={r.id}
                  className="relative pl-8 sm:pl-10 pb-16 cl-rise"
                  style={{ scrollMarginTop: "5rem", animationDelay: `${Math.min(ri, 6) * 70}ms` }}
                >
                  {/* node dot on the spine */}
                  <span
                    className="absolute top-1.5 w-[11px] h-[11px] rounded-full"
                    style={{ left: 0, backgroundColor: dot, boxShadow: `0 0 0 4px ${SOL.base3}, 0 0 0 5px ${dot}33` }}
                    aria-hidden
                  />

                  {/* header */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-1.5">
                    <span className="text-sm font-mono font-semibold" style={{ color: SOL.base03 }}>
                      {r.month}
                    </span>
                    <span
                      className="text-[11px] font-mono px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: SOL.base2, color: SOL.base01 }}
                    >
                      {r.version}
                    </span>
                    {r.desktop && (
                      <span className="text-[11px] font-mono" style={{ color: SOL.base01 }}>
                        {r.desktop}
                      </span>
                    )}
                    {r.tag && (
                      <span
                        className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: `${dot}1a`, color: dot }}
                      >
                        {r.tag}
                      </span>
                    )}
                  </div>

                  <h2 className="text-2xl font-bold font-mono leading-snug mb-3" style={{ color: SOL.base03 }}>
                    {r.headline}
                  </h2>
                  <p className="text-[15px] leading-relaxed mb-7 max-w-2xl" style={{ color: SOL.base00 }}>
                    {r.summary}
                  </p>

                  {/* month hero — illustrates the headline feature */}
                  <MonthHero id={r.id} ac={dot} label={r.headline} />

                  {/* topical cards */}
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-6">
                    {r.sections.map((s, si) => {
                      const ac = ACCENT[s.accent];
                      const Icon = ICONS[s.icon] ?? Boxes;
                      return (
                        <div
                          key={s.title}
                          className="cl-card rounded-xl overflow-hidden"
                          style={{ backgroundColor: `${SOL.base2}55`, "--ac": ac } as CSSProperties}
                        >
                          <SectionHeader ac={ac} Icon={Icon} kind={ri + si} uid={`${r.id}-${si}`} />
                          <div className="pt-7 px-4 pb-4">
                            <h3 className="font-mono text-sm font-semibold leading-tight mb-3" style={{ color: SOL.base03 }}>
                              {s.title}
                            </h3>
                            <ul className="space-y-2">
                              {s.items.map((item, i) => (
                                <li key={i} className="flex gap-2.5 text-sm leading-relaxed" style={{ color: SOL.base00 }}>
                                  <span
                                    className="shrink-0 h-px w-2.5 mt-[0.62em] rounded-full"
                                    style={{ backgroundColor: ac }}
                                    aria-hidden
                                  />
                                  <span>
                                    <Inline text={item} />
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {/* tail cap */}
            <div className="relative pl-8 sm:pl-10">
              <span
                className="absolute top-1 w-[7px] h-[7px] rounded-full"
                style={{ left: 2, backgroundColor: SOL.base1 }}
                aria-hidden
              />
              <p className="text-sm" style={{ color: SOL.base01 }}>
                The first commit landed in December 2025.
              </p>
            </div>
          </div>

          {/* CTA */}
          <div
            className="mt-16 rounded-xl p-7 flex flex-wrap items-center justify-between gap-4"
            style={{ backgroundColor: SOL.base02 }}
          >
            <div>
              <div className="font-mono font-bold text-lg" style={{ color: SOL.base3 }}>
                Start capturing your sessions
              </div>
              <div className="text-sm mt-1" style={{ color: SOL.base1 }}>
                One command. Works with Claude Code, Codex, Gemini, and Cursor.
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/documentation">
                <Button variant="ghost" className="font-medium" style={{ color: SOL.base1 }}>
                  Read the docs
                </Button>
              </Link>
              <Link href="/signup">
                <Button className="font-medium" style={{ backgroundColor: SOL.cyan, color: SOL.base03 }}>
                  Get started
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Footer — matches the landing page */}
      <footer style={{ borderTop: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3 }}>
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <Logo size="md" className="[--logo-c:#444444] text-[#002b36] mb-4" />
              <p className="text-sm" style={{ color: SOL.base00 }}>
                The operating system for AI coding agents.
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-3 text-sm" style={{ color: SOL.base03 }}>
                Product
              </h4>
              <ul className="space-y-2 text-sm" style={{ color: SOL.base00 }}>
                <li><Link href="/documentation" className="hover:text-[#073642]">Documentation</Link></li>
                <li><Link href="/features" className="hover:text-[#073642]">CLI</Link></li>
                <li><Link href="/changelog" className="hover:text-[#073642]">Changelog</Link></li>
                <li><Link href="/security" className="hover:text-[#073642]">Security</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-3 text-sm" style={{ color: SOL.base03 }}>
                Company
              </h4>
              <ul className="space-y-2 text-sm" style={{ color: SOL.base00 }}>
                <li><Link href="/about" className="hover:text-[#073642]">About</Link></li>
                <li><Link href="/privacy" className="hover:text-[#073642]">Privacy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-3 text-sm" style={{ color: SOL.base03 }}>
                Connect
              </h4>
              <ul className="space-y-2 text-sm" style={{ color: SOL.base00 }}>
                <li><a href="https://github.com/codecast-sh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://x.com/codecastsh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Twitter</a></li>
                <li><a href="https://discord.gg/S7V5Wnfq" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Discord</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t mt-8 pt-8 text-center text-sm" style={{ borderColor: SOL.base2, color: SOL.base0 }}>
            &copy; 2025 Codecast
          </div>
        </div>
      </footer>
    </main>
  );
}
