"use client";

import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { Whole } from "../kit";
import { Tile } from "./kit";
import { BODY, INK, LINE, MUTED, PAPER, SAND, SOL, TEXT } from "./model";

/*
 * The end of the page: every org command in one table for people who script,
 * the features the org leans on, and the install.
 */

const COMMANDS: [string, string][] = [
  ["cast org where", "the work this session is bound to, the role that answers for it and the chain above"],
  ["cast route \"<request>\"", "file a request with the role that owns it and wake that role"],
  ["cast role wake @eng \"<message>\"", "write to a role's standing session"],
  ["cast role create \"Release Captain\" --reports-to @eng", "add a role by hand"],
  ["cast org staff", "hire the Head of People; its first review runs at once"],
  ["cast org health", "every area's status in words"],
  ["cast role pause @social", "pause a role's triggers; messages still arrive"],
  ["cast org log", "every change to the org, newest first, with who made it"],
];

const RELATED: { slug: string; why: string }[] = [
  { slug: "decisions", why: "Questions a role cannot settle reach you as one card with its recommendation." },
  { slug: "triggers", why: "A role's daily check and its other routines are ordinary triggers you can pause or edit." },
  { slug: "agents", why: "Workers a role starts nest under it, on whichever agent fits the job." },
  { slug: "memory", why: "A role's brief and every session under it stay searchable for the next agent." },
];

function Reference() {
  return (
    <section className="py-20 sm:py-24 border-t" style={{ borderColor: LINE }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <div>
          <h2 className="font-mono font-bold text-[24px] sm:text-[28px] tracking-[-0.03em] leading-tight" style={{ color: INK }}>The org from a terminal</h2>
          <p className="mt-4 text-[15px] leading-7" style={{ color: BODY }}>
            Everything on the chart has a command, for scripts and for the agents themselves. A role runs these from its own session.
          </p>
        </div>
        <div className="rounded-xl overflow-hidden" style={{ backgroundColor: INK }}>
          {COMMANDS.map(([cmd, what], i) => (
            <div key={cmd} className="grid sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-6 gap-y-1 px-5 py-3 border-b last:border-b-0" style={{ borderColor: "rgba(147,161,161,.14)", backgroundColor: i % 2 ? "rgba(7,54,66,.5)" : undefined }}>
              <code className="font-mono text-[12.5px] leading-6" style={{ color: SAND }}><span style={{ color: SOL.green }}>$ </span><Whole text={cmd} /></code>
              <span className="text-[13px] leading-6" style={{ color: SOL.base1 }}>{what}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Related() {
  const items = RELATED.flatMap((r) => {
    const f = FEATURE_DEEP_DIVES.find((x) => x.slug === r.slug);
    return f ? [{ ...r, f }] : [];
  });
  return (
    <section style={{ backgroundColor: PAPER }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 pb-20">
        <h2 className="font-mono font-bold text-[24px] sm:text-[28px] tracking-[-0.03em] mb-8" style={{ color: INK }}>Related features</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {items.map(({ slug, why, f }) => (
            <Link key={slug} href={featureHref(slug)} className="og-lift group rounded-xl border p-5 hover:bg-[rgba(238,232,213,.5)]" style={{ borderColor: LINE }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f.color }} />
                <span className="font-mono font-bold text-[15px] group-hover:underline underline-offset-4" style={{ color: TEXT }}>{f.name}</span>
              </div>
              <p className="text-[14px] leading-6" style={{ color: MUTED }}>{why}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section id="install" className="scroll-mt-20" style={{ backgroundColor: INK }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 items-center">
        <div>
          <div className="flex gap-1.5 mb-6">
            {(["org chart", "terminal window", "rocket launch", "billboard", "customer check"] as const).map((k) => <Tile key={k} k={k} size={30} />)}
          </div>
          <h2 className="font-mono font-bold text-[28px] sm:text-[36px] leading-[1.12] tracking-[-0.03em]" style={{ color: PAPER }}>
            Set up your org
          </h2>
          <p className="mt-5 text-[16px] leading-7 max-w-lg" style={{ color: SOL.base1 }}>
            Install codecast and open <b style={{ color: SAND }}>Org</b> in the sidebar. Hire the Head of People first: it reads your projects and sessions, proposes the leads your work needs, and you approve each one.
          </p>
          <div className="mt-6 flex items-center gap-2 text-[13px] font-mono" style={{ color: SOL.base1 }}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: SOL.violet }} />
            <Link href="/documentation/org-roles" className="underline underline-offset-4 hover:text-[#fdf6e3]">Read the org guide</Link>
          </div>
        </div>
        <div className="rounded-xl p-5 sm:p-6" style={{ backgroundColor: PAPER }}>
          <InstallTabs location="feature-org" />
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <>
      <Reference />
      <Related />
      <Cta />
    </>
  );
}
