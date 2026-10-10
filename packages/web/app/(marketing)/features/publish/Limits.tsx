"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { SOL } from "../../blog/blogChrome";
import { InstallTabs } from "@/components/install-tabs";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { C, CYAN, Section } from "./kit";

const LIMITS: { q: string; a: ReactNode }[] = [
  { q: "How big can a page be?", a: <>8 MB for a file or a folder&apos;s files together. Video and audio don&apos;t count; each can be up to 2 GB. Over the cap, the CLI names the five biggest files so you know what to trim.</> },
  { q: "What can I publish?", a: <>An <C>.html</C> file, a <C>.md</C> file, or a folder with an <C>index.html</C> (or exactly one <C>.html</C> file). Other single files are refused. Images go through <C>cast image</C>, which takes raster formats only: SVG is excluded because it can carry script.</> },
  { q: "Is an unlisted link private?", a: <>No. Anyone holding the link can open it unless you add a gate. Links are long and random and never indexed, so nobody finds one by searching. For anything sensitive, add a password or an expiry.</> },
  { q: "Can I take a page back after sharing it?", a: <>You can close the link (Delete in Pages, an expiry, a new password) and caches stop serving it within six minutes. You can&apos;t recall a copy a reader already saved.</> },
  { q: "Can scripts on my page use storage or cookies?", a: <>Scripts run, forms submit and popups open, but the page runs sandboxed in its own opaque origin. It has no access to codecast sign-in, and browser storage tied to an origin, like cookies and localStorage, is unavailable to it.</> },
  { q: "Do comments always reach the agent?", a: <>Only when the page was published from a codecast session, and only when the owner sends them. Comments on a page published outside a session stay on the page. If the session can&apos;t be reached, comments are kept as unsent and <strong>Send all</strong> retries later.</> },
  { q: "Do readers get notified of a new version?", a: <>No. A reader with <C>?live=1</C> on the link reloads on each new version; everyone else sees the newest version the next time they open the link. Old versions stay reachable at <C>?v=N</C>.</> },
  { q: "What does a live-updating page not do?", a: <>The live loop doesn&apos;t change gates after the first publish, and it captures the thumbnail only once. The thumbnail needs Chrome on the machine; without it, the publish goes ahead with no thumbnail.</> },
];

export function Limits() {
  return (
    <Section id="limits" n="09" tone="sand" title="Limits, plainly." lede="What it will not do, and what to expect at the edges.">
      <div className="grid md:grid-cols-2 gap-x-12 gap-y-9">
        {LIMITS.map((l) => (
          <div key={l.q}>
            <h3 className="font-mono text-[15px] font-bold leading-6" style={{ color: SOL.base03 }}>{l.q}</h3>
            <p className="mt-2 text-[15px] leading-7" style={{ color: SOL.base01 }}>{l.a}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

const RELATED = ["browser", "pull-requests", "decisions", "triggers"];

export function Closing() {
  const related = RELATED.map((s) => FEATURE_DEEP_DIVES.find((f) => f.slug === s)).filter((f): f is NonNullable<typeof f> => !!f);
  return (
    <section className="relative overflow-hidden" style={{ backgroundColor: SOL.base03 }}>
      <div className="absolute inset-0 opacity-[.07]" style={{ backgroundImage: "linear-gradient(#2aa198 1px, transparent 1px), linear-gradient(90deg, #2aa198 1px, transparent 1px)", backgroundSize: "28px 28px" }} />
      <div className="relative max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-12 items-center">
          <div>
            <h2 className="font-mono font-bold text-[28px] sm:text-[38px] leading-[1.12] tracking-[-0.035em] [text-wrap:balance]" style={{ color: SOL.base3 }}>
              Install codecast, then ask your agent to publish what it made.
            </h2>
            <p className="mt-5 text-[17px] leading-8 max-w-lg" style={{ color: SOL.base1 }}>
              Agents running under codecast already know the command. The next report it writes can be a link you send, not a file you dig out of a transcript.
            </p>
          </div>
          <div className="min-w-0">
            <InstallTabs location="feature-publish" />
          </div>
        </div>

        <div className="mt-20">
          <div className="font-mono text-[13px] font-semibold" style={{ color: SOL.base1 }}>Works well with</div>
          <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {related.map((f) => (
              <Link
                key={f.slug}
                href={featureHref(f.slug)}
                className="pb-lift group block rounded-xl border p-5"
                style={{ borderColor: "rgba(147,161,161,.2)", backgroundColor: "rgba(7,54,66,.6)" }}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: f.color }} />
                  <span className="font-mono text-[14px] font-semibold" style={{ color: SOL.base3 }}>{f.name}</span>
                  <span className="ml-auto transition-transform group-hover:translate-x-0.5" style={{ color: CYAN }} aria-hidden>→</span>
                </div>
                <p className="mt-3 text-[13.5px] leading-6" style={{ color: SOL.base1 }}>{f.dek}</p>
              </Link>
            ))}
          </div>
          <p className="mt-8 text-[14px]" style={{ color: SOL.base01 }}>
            The story behind the feature, with real captures:{" "}
            <Link href="/blog/a-url-for-everything-your-agent-makes" className="underline underline-offset-4" style={{ color: CYAN }}>A URL for everything your agent makes</Link>.
          </p>
        </div>
      </div>
    </section>
  );
}
