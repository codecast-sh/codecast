"use client";

import { useState } from "react";
import { copyToClipboard } from "../lib/utils";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: {
    label: string;
    href: string;
  };
  variant?: "default" | "onboarding";
}

const FAKE_SESSIONS = [
  {
    title: "Fix authentication redirect loop",
    agent: "claude_code",
    project: "webapp",
    duration: "12m",
    messages: 24,
    time: "3m ago",
    subtitle: "Debug OAuth callback URL mismatch causing infinite redirect after login",
    active: true,
  },
  {
    title: "Add rate limiting to API endpoints",
    agent: "claude_code",
    project: "api-server",
    duration: "8m",
    messages: 16,
    time: "15m ago",
    subtitle: "Implement token bucket rate limiter with Redis backing store",
  },
  {
    title: "Refactor database migration scripts",
    agent: "cursor",
    project: "platform",
    duration: "23m",
    messages: 41,
    time: "1h ago",
    subtitle: "Consolidate migration files and add rollback support",
  },
  {
    title: "Implement search indexing pipeline",
    agent: "claude_code",
    project: "search-svc",
    duration: "45m",
    messages: 67,
    time: "2h ago",
    subtitle: "Build incremental indexing with Elasticsearch bulk API",
  },
  {
    title: "Debug memory leak in worker process",
    agent: "claude_code",
    project: "workers",
    duration: "18m",
    messages: 32,
    time: "4h ago",
    subtitle: "Track down event listener accumulation in long-running queue consumer",
  },
  {
    title: "Add WebSocket reconnection logic",
    agent: "cursor",
    project: "realtime",
    duration: "6m",
    messages: 11,
    time: "Yesterday",
    subtitle: "Exponential backoff with jitter for dropped connections",
  },
];

const INSTALL_COMMAND = "curl -fsSL codecast.sh/install | sh";

function FakeSessionCard({ session, className = "" }: { session: typeof FAKE_SESSIONS[0]; className?: string }) {
  return (
    <div className={`relative border rounded-xl p-3 md:p-4 bg-white dark:bg-sol-bg-alt border-sol-border/40 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-4 h-4 rounded bg-sol-yellow flex items-center justify-center shrink-0">
            <svg className="w-2.5 h-2.5 text-sol-bg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </span>
          <span className="font-medium text-sm text-sol-text truncate">{session.title}</span>
          {session.active && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-green/20 border border-sol-green/50 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green" />
              <span className="text-[10px] text-sol-green font-semibold">LIVE</span>
            </span>
          )}
        </div>
        <span className="text-[11px] text-sol-text-dim/50 shrink-0">{session.time}</span>
      </div>
      {session.subtitle && (
        <p className="text-xs text-sol-text-muted mb-2 line-clamp-1">{session.subtitle}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-sol-text-muted0">
        <span className="inline-flex items-center gap-1 text-sol-text-dim">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
          {session.project}
        </span>
        <span className="inline-flex items-center gap-1 text-sol-text-dim">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {session.duration}
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sol-border/30 text-sol-text-dim">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-[10px] font-semibold">{session.messages}</span>
        </span>
      </div>
    </div>
  );
}

function OnboardingEmptyState() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyToClipboard(INSTALL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative overflow-hidden">
      {/* Fake sessions background */}
      <div className="space-y-3 opacity-[0.12] pointer-events-none select-none" aria-hidden="true">
        {FAKE_SESSIONS.map((session, i) => (
          <FakeSessionCard key={i} session={session} />
        ))}
      </div>

      {/* CTA overlay */}
      <div className="absolute inset-0 flex items-start justify-center pt-16 sm:pt-24">
        <div className="relative max-w-lg w-full mx-4">
          {/* Backdrop blur card */}
          <div className="rounded-2xl border border-sol-border/60 bg-sol-bg/90 dark:bg-sol-bg/95 backdrop-blur-xl shadow-2xl p-6 sm:p-8">
            <div className="text-center mb-6">
              <h2 className="text-xl sm:text-2xl font-semibold text-sol-text mb-2 font-serif">
                Start syncing your sessions
              </h2>
              <p className="text-sm text-sol-text-muted">
                Install the CLI to automatically capture and sync your coding sessions.
              </p>
            </div>

            {/* Install command */}
            <div className="rounded-xl overflow-hidden border border-sol-border/80 mb-4">
              <div className="flex items-center justify-between gap-3 bg-sol-base02 px-4 py-3">
                <code className="text-sol-base1 text-sm font-mono truncate">
                  <span className="text-sol-base01 select-none">$ </span>
                  {INSTALL_COMMAND}
                </code>
                <button
                  onClick={handleCopy}
                  className="p-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-base01 rounded-md transition-colors shrink-0"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <svg className="w-4 h-4 text-sol-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <p className="text-xs text-sol-text-dim text-center">
              Works with Claude Code, Cursor, Windsurf, and more.{" "}
              <a href="/settings/cli" className="text-sol-yellow hover:text-sol-yellow/80 transition-colors">
                Setup guide
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action, variant }: EmptyStateProps) {
  if (variant === "onboarding") {
    return <OnboardingEmptyState />;
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 bg-sol-base02 rounded-full flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-sol-base0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-sol-text mb-2">{title}</h3>
      <p className="text-sol-text-muted max-w-sm mb-4">{description}</p>
      {action && (
        <a
          href={action.href}
          className="text-blue-400 hover:text-blue-300 text-sm"
        >
          {action.label} &rarr;
        </a>
      )}
    </div>
  );
}
