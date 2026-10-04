"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { Hero } from "./Hero";
import { Anatomy, Belongs, Clearing, Evidence, KeepTrue, Limits, Modes, Reference, Stacks, ThreeWays } from "./Sections";
import { LINE } from "./mocks";
import { Y } from "./kit";
import "./decisions.css";

const RELATED: { slug: string; why: string }[] = [
  { slug: "triggers", why: "An answer that should run work later: arm a trigger from the session that got it." },
  { slug: "agents", why: "Workers you spawn ask through the same queue, so a fan-out reaches you as one sitting." },
  { slug: "pull-requests", why: "A finished change can come to you as a card that asks Ship, Revise or Drop." },
  { slug: "memory", why: "Record the why with cast decisions add, so the next agent starts from it." },
];

function Related() {
  const items = RELATED.map((r) => ({ ...r, f: FEATURE_DEEP_DIVES.find((f) => f.slug === r.slug) })).filter((r) => r.f);
  return (
    <section style={{ backgroundColor: SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20">
        <h2 className="font-mono font-bold text-[24px] sm:text-[28px] tracking-[-0.03em] mb-8" style={{ color: SOL.base03 }}>Works with</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {items.map(({ slug, why, f }) => (
            <Link key={slug} href={featureHref(slug)} className="group rounded-xl border p-5 transition-colors hover:bg-[rgba(238,232,213,.5)]" style={{ borderColor: LINE }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f!.color }} />
                <span className="font-mono font-bold text-[15px] group-hover:underline underline-offset-4" style={{ color: SOL.base02 }}>{f!.name}</span>
              </div>
              <p className="text-[14px] leading-6" style={{ color: SOL.base01 }}>{why}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section id="install" className="scroll-mt-20" style={{ backgroundColor: SOL.base03 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 items-center">
        <div>
          <h2 className="font-mono font-bold text-[28px] sm:text-[36px] leading-[1.12] tracking-[-0.03em]" style={{ color: SOL.base3 }}>
            Let your agents ask. Answer when you sit down.
          </h2>
          <p className="mt-5 text-[16px] leading-7 max-w-lg" style={{ color: SOL.base1 }}>
            Install codecast, then <span className="font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(181,137,0,.18)", color: SOL.base2 }}>cast install decide</span> to give your agents the snippet that says when to queue a choice and how to write the card. Your queue lives at <span className="font-mono" style={{ color: SOL.base2 }}>/questions</span> on the web and in the phone app.
          </p>
          <div className="mt-6 flex items-center gap-2 text-[13px] font-mono" style={{ color: SOL.base1 }}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: Y }} />
            <Link href="/documentation/decisions" className="underline underline-offset-4 hover:text-[#fdf6e3]">Read the full decisions guide</Link>
          </div>
        </div>
        <div className="rounded-xl p-5 sm:p-6" style={{ backgroundColor: SOL.base3 }}>
          <InstallTabs location="feature-decisions" />
        </div>
      </div>
    </section>
  );
}

export default function DecisionsPage() {
  // ?static renders every element at rest (no entrance motion), for captures.
  const [still, setStill] = useState(false);
  useEffect(() => { setStill(new URLSearchParams(window.location.search).has("static")); }, []);
  return (
    <main className="dq-root" data-static={still ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      <Hero />
      <ThreeWays />
      <Anatomy />
      <Modes />
      <Evidence />
      <Clearing />
      <Stacks />
      <KeepTrue />
      <Belongs />
      <Reference />
      <Limits />
      <Related />
      <Cta />
    </main>
  );
}
