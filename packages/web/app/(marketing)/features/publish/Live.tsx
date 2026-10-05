"use client";

import { SOL, Terminal } from "../../blog/blogChrome";
import { BrowserFrame, C, CYAN, Note, PageBar, SITE, Section } from "./kit";

const SLUG = "Pq7wLx2RnB4s";

/** One save in the timeline: what the editor wrote, what the CLI printed, what the reader saw. */
/** The saves after the first publish, as the watch loop prints them. */
const BEATS: { t: string; out: React.ReactNode }[] = [
  { t: "14:05:40", out: <><span style={{ color: SOL.yellow }}>v2</span> → updated</> },
  { t: "14:05:52", out: <span style={{ color: SOL.base01 }}>unchanged (v2)</span> },
  { t: "14:09:03", out: <><span style={{ color: SOL.yellow }}>v3</span> → updated</> },
];

function LiveTab() {
  return (
    <BrowserFrame
      url={`${SITE}${SLUG}?live=1`}
      urlNode={
        <span className="flex items-center gap-1.5 min-w-0 w-full">
          <span className="truncate">{SITE}{SLUG}<span style={{ color: CYAN }}>?live=1</span></span>
          <span className="ml-auto inline-flex items-center gap-1 shrink-0 text-[10px]" style={{ color: CYAN }}>
            <span className="pb-anim pb-pulse h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CYAN, animationIterationCount: "infinite", animationDuration: "1.6s" }} />
            live
          </span>
        </span>
      }
    >
      <PageBar title="Pricing page proposal" session="Pricing rework" when="Oct 4, 2026" version="v3" comments={0} />
      <div className="px-6 py-6 text-left">
        <div className="font-mono font-bold text-[18px] tracking-tight" style={{ color: SOL.base03 }}>Pricing page proposal</div>
        <p className="mt-2 text-[13px] leading-6 relative" style={{ color: SOL.base01 }}>
          <span className="pb-hl">Two plans instead of four. Teams pay per seat; solo use stays free.</span>
          <span className="ml-2 align-middle inline-block rounded px-1.5 py-px font-mono text-[9.5px] font-semibold" style={{ color: CYAN, backgroundColor: "rgba(42,161,152,.12)" }}>new in v3</span>
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          {["Solo", "Team"].map((p, i) => (
            <div key={p} className="rounded-lg border p-3" style={{ borderColor: i ? CYAN : "rgba(88,110,117,.2)", backgroundColor: i ? "rgba(42,161,152,.05)" : undefined }}>
              <div className="font-mono text-[11px] font-semibold" style={{ color: SOL.base02 }}>{p}</div>
              <div className="mt-2 h-1.5 w-2/3 rounded-full" style={{ backgroundColor: SOL.base2 }} />
              <div className="mt-1.5 h-1.5 w-1/2 rounded-full" style={{ backgroundColor: SOL.base2 }} />
            </div>
          ))}
        </div>
      </div>
    </BrowserFrame>
  );
}

export function Live() {
  return (
    <Section
      id="watch"
      n="02"
      tone="sand"
      title="Watch the page while the agent writes it."
      lede={<>Add <C>--watch</C> and the CLI stays on the file, republishing every time it changes. Open the link with <C>?live=1</C> and the reader&apos;s tab reloads itself on each new version. You review a draft as it forms, at the URL you will send.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-8 lg:gap-10 items-center">
        <div className="min-w-0">
          <div className="[&>div]:my-0">
            <Terminal label="~/work/pricing">
              <span style={{ color: SOL.green }}>$</span><span style={{ color: SOL.base1 }}> cast publish proposal.md --watch</span>{"\n"}
              <span style={{ color: SOL.green }}>✓</span> <span style={{ color: SOL.base2 }}>Pricing page proposal</span>  <span style={{ color: SOL.yellow }}>v1</span> → published{"\n"}
              {"  "}<span style={{ color: CYAN }}>https://{SITE}{SLUG}</span>{"\n\n"}
              <span style={{ color: SOL.base01 }}>watching proposal.md — Ctrl+C to stop</span>{"\n"}
              <span style={{ color: SOL.base01 }}>live view: https://{SITE}{SLUG}?live=1</span>{"\n"}
              {BEATS.map((b) => (
                <span key={b.t} className="block">{"  "}{b.t}  {b.out}</span>
              ))}
            </Terminal>
          </div>
        </div>
        <div className="min-w-0">
          <LiveTab />
        </div>
      </div>
      <div className="mt-12 grid sm:grid-cols-2 gap-x-12 gap-y-6 max-w-4xl">
            <Note>
              <strong style={{ color: SOL.base02 }}>Saves are batched.</strong> Changes settle for 400 ms before a publish, and a save that lands mid-publish queues one more.
              The CLI watches the folder, so editors that save by replacing the file are caught too.
            </Note>
            <Note>
              <strong style={{ color: SOL.base02 }}>No empty versions.</strong> The server hashes the content. A save that changes nothing comes back as{" "}
              <C>unchanged</C> and the version number holds.
            </Note>
            <Note>
              <strong style={{ color: SOL.base02 }}>Gates are set once.</strong> Access flags on the first publish apply to the page; the watch loop republishes
              content only. Change gates later with <C>cast publish set</C>.
            </Note>
            <Note>
              <strong style={{ color: SOL.base02 }}>A folder works too.</strong> Watching a bundle is recursive: edit any stylesheet, script or chart inside it
              and the page republishes.
            </Note>
      </div>
    </Section>
  );
}
