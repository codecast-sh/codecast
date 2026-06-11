"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { MessageSquare, MapPin, Github, ArrowUpRight, Pin } from "lucide-react";
import { AgentTypeIcon, formatAgentType } from "../../../components/AgentTypeIcon";
import { ActivityHeatmap } from "../../../components/ActivityHeatmap";
import { LogoMark } from "../../../components/Logo";

// Local relative-time formatter, matching the convention used ad-hoc across the
// app's pages (notifications, schedules) — no shared util exists to import.
function timeAgo(ts?: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default function PublicProfilePage() {
  const params = useParams();
  const username = (params.username as string) || "";

  const profile = useQuery(api.users.getPublicProfile, { username });
  const pins = useQuery(api.users.getPublicPinnedSessions, { username });
  const heatmap = useQuery(api.users.getPublicActivityHeatmap, { username });

  // undefined = still loading; null = no such (enabled) profile → 404.
  if (profile === undefined) return <ProfileShell><ProfileSkeleton /></ProfileShell>;
  if (profile === null) return <ProfileShell><NotFound username={username} /></ProfileShell>;

  const initial = (profile.name || profile.username || "?").charAt(0).toUpperCase();

  return (
    <ProfileShell>
      <div className="mx-auto w-full max-w-3xl px-5 pb-24">
        {/* Identity */}
        <header className="reveal pt-10 sm:pt-14 flex flex-col sm:flex-row sm:items-end gap-5">
          <div className="shrink-0">
            {profile.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={profile.name ?? profile.username ?? "avatar"}
                className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl object-cover ring-1 ring-sol-base01/30 shadow-xl shadow-black/20"
              />
            ) : (
              <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-sol-base02 ring-1 ring-sol-base01/30 grid place-items-center text-4xl font-semibold text-sol-base0">
                {initial}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-sol-base1 leading-tight">
              {profile.name || profile.username}
            </h1>
            <div className="mt-0.5 text-sol-cyan font-mono text-sm">@{profile.username}</div>
            {profile.title && (
              <div className="mt-2 text-sol-base0 text-sm">{profile.title}</div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-sol-base00">
              {profile.github_username && (
                <a
                  href={`https://github.com/${profile.github_username}`}
                  target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-sol-base1 transition-colors"
                >
                  <Github className="w-3.5 h-3.5" /> {profile.github_username}
                </a>
              )}
              {profile.timezone && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> {profile.timezone}
                </span>
              )}
            </div>
          </div>
        </header>

        {profile.bio && (
          <p className="reveal reveal-1 mt-5 text-sol-base0 text-sm leading-relaxed max-w-2xl whitespace-pre-wrap">
            {profile.bio}
          </p>
        )}

        {/* Stats */}
        <div className="reveal reveal-1 mt-6 flex flex-wrap gap-2.5">
          <StatChip label="pinned" value={profile.stats.pinned_sessions} />
          <StatChip label="messages" value={profile.stats.pinned_messages} />
        </div>

        {/* Contribution graph */}
        {profile.show_activity_graph && heatmap && heatmap.length > 0 && (
          <section className="reveal reveal-2 mt-9 rounded-2xl border border-sol-base02/70 bg-sol-base02/30 px-4 py-3">
            <ActivityHeatmap data={heatmap} label="Contribution activity" />
          </section>
        )}

        {/* Pinned sessions */}
        <section className="reveal reveal-2 mt-10">
          <div className="flex items-center gap-2 mb-3">
            <Pin className="w-3.5 h-3.5 text-sol-base01" />
            <h2 className="text-[11px] uppercase tracking-widest font-bold text-sol-base01">
              Pinned sessions
            </h2>
          </div>
          {pins === undefined ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <CardSkeleton /><CardSkeleton />
            </div>
          ) : pins.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-sol-base02 px-5 py-10 text-center text-sm text-sol-base00">
              No pinned sessions yet.
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {pins.map((p: any) => <SessionCard key={p._id} pin={p} />)}
            </div>
          )}
        </section>
      </div>
    </ProfileShell>
  );
}

function SessionCard({ pin }: { pin: any }) {
  return (
    <Link
      href={`/share/${pin.share_token}`}
      className="group relative block rounded-2xl border border-sol-base02/80 bg-sol-base02/20 p-4 transition-all hover:-translate-y-0.5 hover:border-sol-cyan/40 hover:bg-sol-base02/40"
    >
      <ArrowUpRight className="absolute top-3.5 right-3.5 w-4 h-4 text-sol-base01/40 transition-colors group-hover:text-sol-cyan" />
      <h3 className="pr-6 text-sm font-semibold text-sol-base1 leading-snug line-clamp-2">
        {pin.title || "Untitled session"}
      </h3>
      {pin.subtitle && (
        <p className="mt-1 text-xs text-sol-base00 line-clamp-2 leading-relaxed">{pin.subtitle}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-base01">
        {pin.repo && (
          <span className="inline-flex items-center gap-1 font-mono text-sol-green/90">{pin.repo}</span>
        )}
        {pin.agent && (
          <span className="inline-flex items-center gap-1">
            <AgentTypeIcon agentType={pin.agent} className="w-3 h-3" />
            {formatAgentType(pin.agent)}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="w-3 h-3" /> {pin.message_count}
        </span>
        <span className="ml-auto text-sol-base01/70">{timeAgo(pin.updated_at)}</span>
      </div>
    </Link>
  );
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-sol-base02/70 bg-sol-base02/30 px-3.5 py-2">
      <span className="text-base font-bold text-sol-base1 tabular-nums">{value}</span>
      <span className="ml-1.5 text-[11px] text-sol-base01">{label}</span>
    </div>
  );
}

// Standalone chrome — this page lives OUTSIDE the dashboard shell (it's an
// anonymous, guest-viewable route), so it brings its own nav + atmosphere.
function ProfileShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen bg-sol-base03 text-sol-base0 overflow-x-hidden">
      {/* atmospheric glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(38,139,210,0.14), rgba(42,161,152,0.06) 40%, transparent 75%)",
        }}
      />
      <nav className="relative z-10 flex items-center justify-between px-5 sm:px-8 h-14 border-b border-sol-base02/50">
        <Link href="/" className="flex items-center gap-2 group">
          <LogoMark className="w-6 h-6" />
          <span className="font-semibold text-sol-base1 tracking-tight group-hover:text-sol-cyan transition-colors">codecast</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/login" className="text-sol-base00 hover:text-sol-base1 transition-colors">Sign in</Link>
          <Link
            href="/signup"
            className="rounded-lg bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 px-3 py-1.5 font-medium hover:bg-sol-cyan/25 transition-colors"
          >
            Get codecast
          </Link>
        </div>
      </nav>
      <div className="relative z-10">{children}</div>
    </main>
  );
}

function NotFound({ username }: { username: string }) {
  return (
    <div className="mx-auto max-w-md px-5 pt-28 text-center">
      <div className="text-5xl mb-4">🛰️</div>
      <h1 className="text-xl font-semibold text-sol-base1">No public profile here</h1>
      <p className="mt-2 text-sm text-sol-base00">
        <span className="font-mono text-sol-base0">@{username}</span> hasn’t set up a public
        codecast profile, or the handle doesn’t exist.
      </p>
      <Link href="/" className="mt-6 inline-block text-sm text-sol-cyan hover:underline">
        ← Back to codecast
      </Link>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-14 animate-pulse">
      <div className="flex gap-5 items-end">
        <div className="w-28 h-28 rounded-2xl bg-sol-base02/60" />
        <div className="flex-1 space-y-3 pb-2">
          <div className="h-7 w-48 rounded bg-sol-base02/60" />
          <div className="h-4 w-32 rounded bg-sol-base02/40" />
        </div>
      </div>
      <div className="mt-8 h-20 rounded-2xl bg-sol-base02/40" />
      <div className="mt-8 grid sm:grid-cols-2 gap-3">
        <CardSkeleton /><CardSkeleton />
      </div>
    </div>
  );
}

function CardSkeleton() {
  return <div className="h-28 rounded-2xl bg-sol-base02/40 animate-pulse" />;
}
