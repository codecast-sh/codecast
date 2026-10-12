"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, CYAN, Note, Section } from "./kit";

function Icon({ d }: { d: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** The block card a page URL becomes when it stands alone on a line (PublishedPageEmbed). */
function EmbedCard() {
  return (
    <div className="my-3 rounded-md border overflow-hidden" style={{ borderColor: "rgba(88,110,117,.28)" }}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: "rgba(88,110,117,.22)", backgroundColor: SOL.base2 }}>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: SOL.base02 }}>Pricing page proposal</span>
        <span className="flex items-center gap-2.5" style={{ color: SOL.base1 }}>
          <Icon d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
          <Icon d="m7 15 5 5 5-5M7 9l5-5 5 5" />
          <Icon d="M3 3h18v18H3zM12 3v18" />
          <span className="flex items-center gap-0.5 text-[11px]"><Icon d="M7 17 17 7M7 7h10v10" />open</span>
        </span>
      </div>
      <div className="bg-white px-4 py-4">
        <div className="font-mono font-bold text-[14px]" style={{ color: SOL.base03 }}>Pricing page proposal</div>
        <div className="mt-1.5 text-[11.5px] leading-5" style={{ color: SOL.base01 }}>Two plans instead of four. Teams pay per seat; solo use stays free.</div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded border p-2" style={{ borderColor: i ? CYAN : "rgba(88,110,117,.2)" }}>
              <div className="h-1.5 w-1/2 rounded-full" style={{ backgroundColor: SOL.base2 }} />
              <div className="mt-1.5 h-1.5 w-2/3 rounded-full" style={{ backgroundColor: SOL.base2 }} />
            </div>
          ))}
        </div>
      </div>
      <div className="h-2 flex items-center justify-center" style={{ backgroundColor: SOL.base2 }}>
        <span className="h-[3px] w-8 rounded-full" style={{ backgroundColor: "rgba(88,110,117,.35)" }} />
      </div>
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border py-px pl-1 pr-2 align-baseline text-[11px] font-medium" style={{ borderColor: "rgba(88,110,117,.3)", backgroundColor: SOL.base2, color: SOL.base02 }}>
      <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: CYAN, opacity: 0.75 }} />
      {children}
      <span style={{ color: SOL.base1 }}><Icon d="M7 17 17 7M7 7h10v10" /></span>
    </span>
  );
}

/** An assistant turn in a codecast conversation, showing all three ways a page link renders. */
export function ConversationMock() {
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(88,110,117,.25)", backgroundColor: SOL.base3, boxShadow: "0 30px 60px -34px rgba(0,43,54,.45)" }}>
      <div className="flex items-center gap-2 px-4 h-10 border-b font-mono text-[11.5px]" style={{ borderColor: SOL.base2, color: SOL.base01 }}>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SOL.green }} />
        <span className="font-semibold" style={{ color: SOL.base03 }}>Pricing rework</span>
        <span className="ml-auto">claude</span>
      </div>
      <div className="px-5 py-5 space-y-4 text-[13.5px] leading-6" style={{ color: SOL.base02 }}>
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg px-3 py-2 text-[13px]" style={{ backgroundColor: "rgba(38,139,210,.1)" }}>Draft the new pricing page and show me.</div>
        </div>
        <div>
          <p>The draft is up. It folds the four plans into two and moves the seat math into one table:</p>
          <EmbedCard />
          <p>
            It replaces the <Pill>Current pricing audit</Pill> numbers in the header. The mobile layout before and after:
          </p>
          <div className="mt-3 flex gap-3">
            {["before", "after"].map((t, i) => (
              <figure key={t} className="w-[92px]">
                <div className="h-[150px] rounded-md border p-2 bg-white" style={{ borderColor: "rgba(88,110,117,.25)" }}>
                  <div className="h-2 w-2/3 rounded-full" style={{ backgroundColor: i ? CYAN : SOL.base1, opacity: 0.6 }} />
                  {Array.from({ length: i ? 2 : 4 }).map((_, k) => (
                    <div key={k} className="mt-2 rounded border" style={{ height: i ? 46 : 22, borderColor: "rgba(88,110,117,.2)" }} />
                  ))}
                </div>
                <figcaption className="mt-1 text-center font-mono text-[10px]" style={{ color: SOL.base1 }}>{t}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const WAYS: { syntax: string; result: string }[] = [
  { syntax: "A page the agent puts on its own line", result: "The live page, framed in the thread. Its bar has Pin a note, Copy link, Expand, Open beside your work and Open in a new tab; drag the bottom edge to resize." },
  { syntax: "The same, with a caption", result: "The same frame, with the agent's caption under it." },
  { syntax: "A page named inside a sentence", result: "A small pill with the page's title." },
  { syntax: "A single picture", result: "The image inline, captioned. Screenshots come this way, not as pages." },
];

export function Places() {
  return (
    <Section
      id="conversation"
      n="01"
      tone="sand"
      title="The page shows up where the work is discussed."
      lede={<>In a codecast conversation, a published link is not a bare URL. The agent puts it on its own line and the live page renders in the thread, so you review the deliverable without leaving the session that made it.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-10 items-start">
        <ConversationMock />
        <div className="min-w-0">
          <ul className="divide-y rounded-xl border bg-white/60" style={{ borderColor: "rgba(88,110,117,.2)" }}>
            {WAYS.map((w) => (
              <li key={w.syntax} className="px-5 py-4" style={{ borderColor: "rgba(88,110,117,.15)" }}>
                <div className="font-mono text-[12.5px] font-semibold" style={{ color: CYAN }}>{w.syntax}</div>
                <div className="mt-1 text-[14.5px] leading-6" style={{ color: SOL.base01 }}>{w.result}</div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[15px] leading-7" style={{ color: SOL.base01 }}>
            A note you pin on a framed page rides on your next message to the agent, quoted with the spot it points at, so &quot;make this wider&quot; arrives with the &quot;this&quot;.
          </p>
          <Note className="mt-5">
            For agents and scripts: <C>cast image</C> uploads one picture (PNG, JPEG, GIF, WebP, AVIF or BMP) and prints a stable link plus the markdown to paste, so nobody is handed a local path their browser cannot open.
          </Note>
        </div>
      </div>

      <div className="mt-16 grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 items-center rounded-2xl border p-6 sm:p-8 bg-white/60" style={{ borderColor: "rgba(88,110,117,.2)" }}>
        <div>
          <h3 className="font-mono text-[18px] font-bold tracking-tight" style={{ color: SOL.base03 }}>Attached to the task it proves.</h3>
          <p className="mt-3 text-[15px] leading-7" style={{ color: SOL.base01 }}>
            When the publishing session is working on a task, the page attaches to that task as evidence, stamped with the stage the task was at. Whoever opens the task finds the report, the screenshot page or the dashboard that backs the claim. An agent can name a different task or a plan instead.
          </p>
        </div>
        <div>
          <h3 className="font-mono text-[18px] font-bold tracking-tight" style={{ color: SOL.base03 }}>Every page in one place.</h3>
          <p className="mt-3 text-[15px] leading-7" style={{ color: SOL.base01 }}>
            <b style={{ color: SOL.base02 }}>Pages</b> in the sidebar lists what you published, then your team&apos;s, each card showing its gates, views and open comments. A card&apos;s menu has Open, Copy link, Manage, Edit and Delete.
          </p>
        </div>
      </div>
    </Section>
  );
}
