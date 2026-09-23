"use client";

// The GitHub chip in the marketing nav.
//
// It is the octocat, and beside it the two numbers only codecast can put
// there: the repository's stars, and how many agent sessions are on it right
// now. It links into codecast's own repository page rather than out to
// GitHub, because that page is GitHub's view plus the sessions that wrote
// every line, and its "GitHub" button is the way out. Signed out is fine: the
// page is readable by anyone, and the numbers come from the same public read
// it uses, refreshed once a minute.
//
// Before the read answers, and wherever it cannot (a prerendered page, a
// blocked network), the chip is the plain octocat: a link that says less,
// never one that says "0" for lack of an answer.
import Link from "next/link";
import { Star } from "lucide-react";
import { publicRepoUrl, usePublicRepoRead } from "@/lib/repoTransport";
import { repoSessionsHref } from "@/lib/repoView";
import { SITE_LINKS } from "@/lib/siteLinks";

const INK = "#002b36";
const MUTED = "#657b83";
const DIM = "#93a1a1";
const GREEN = "#859900";

export type RepoPulse = { stargazers_count: number | null; live: number };

export const REPO_PULSE_URL = publicRepoUrl(SITE_LINKS.repository, "pulse", {});

/** The words beside the dot, and the ones that replace them on hover. */
export function pulseWords(live: number): { now: string; hover: string } {
  if (live <= 0) return { now: "quiet now", hover: "see who built it" };
  return { now: `${live} ${live === 1 ? "agent" : "agents"} now`, hover: "watch them build it" };
}

export function GitHubIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function RepoPulseChip({ className = "" }: { className?: string }) {
  const read = usePublicRepoRead<RepoPulse>(REPO_PULSE_URL);
  const pulse = read.data;
  const words = pulse ? pulseWords(pulse.live) : null;
  const live = (pulse?.live ?? 0) > 0;
  const stars = pulse && pulse.stargazers_count !== null ? (
    <span className="flex items-center gap-1 tabular-nums" style={{ color: INK }}>
      {pulse.stargazers_count.toLocaleString()}
      <Star className="w-3 h-3" style={{ color: DIM }} aria-hidden="true" />
    </span>
  ) : null;

  return (
    <Link
      href={repoSessionsHref(SITE_LINKS.repository, "standalone")}
      className={`group flex shrink-0 items-center gap-2 h-8 rounded-md border px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-[#eee8d5] ${className}`}
      style={{ borderColor: "#d6d0bd", color: MUTED }}
      title="Our repository, read in codecast: every file, and the sessions that wrote it"
      aria-label="Codecast's source, with the agent sessions working on it"
    >
      <GitHubIcon className="w-4 h-4 shrink-0" />
      {pulse && (
        <>
          {/* Narrow: the stars alone. Wide: stars, dot and words, and on hover
              the invitation in their place. The hover phrase is about as wide
              as the run it replaces, and both share one cell, so the chip is
              as wide as its content and nothing beside it moves. */}
          <span className="lg:hidden">{stars}</span>
          <span className="hidden lg:grid">
            <span className="col-start-1 row-start-1 flex items-center gap-2 group-hover:invisible">
              {stars}
              <span className="relative flex h-2 w-2" aria-hidden="true">
                {live && <span className="absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping" style={{ backgroundColor: GREEN }} />}
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: live ? GREEN : DIM }} />
              </span>
              <span style={{ color: live ? INK : MUTED }}>{words!.now}</span>
            </span>
            <span className="col-start-1 row-start-1 invisible group-hover:visible" style={{ color: INK }}>{words!.hover}</span>
          </span>
        </>
      )}
    </Link>
  );
}
