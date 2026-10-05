"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, CYAN, Section } from "./kit";

type Row = { cmd: string; does: ReactNode };

const GROUPS: { name: string; rows: Row[] }[] = [
  {
    name: "Publish",
    rows: [
      { cmd: "cast publish <file.html | file.md | dir/>", does: "Publish, or update the page this path already has" },
      { cmd: "--watch", does: "Stay on the file or folder and republish on every change" },
      { cmd: "--title <t>  |  --title -", does: <>Override the title; <C>-</C> reads it from stdin</> },
      { cmd: "--new", does: "A fresh URL even if this path was published before" },
      { cmd: "--task <ct-N>  |  --plan <pl-N>", does: "Attach as evidence (default: the session's active task)" },
      { cmd: "--open", does: "Open the published URL in the browser" },
      { cmd: "--no-thumb", does: "Skip the headless Chrome thumbnail" },
      { cmd: "--json", does: "The raw JSON response" },
    ],
  },
  {
    name: "Gates",
    rows: [
      { cmd: "--password-stdin  |  --password <p>", does: "Require a password; stdin keeps it out of ps" },
      { cmd: "--no-password", does: "Clear the password" },
      { cmd: "--email-gate  |  --no-email-gate", does: "Ask readers for an email address" },
      { cmd: "--expires 30m | 24h | 7d | 2w | never", does: "Give the link a lifespan, or clear it" },
      { cmd: "--edit-mode owner | link | team", does: "Who can edit and publish from the browser" },
      { cmd: "--no-session  |  --session", does: "Hide or show the link to the publishing session" },
      { cmd: "--no-comments  |  --comments", does: "Turn the discussion off or on" },
    ],
  },
  {
    name: "Manage",
    rows: [
      { cmd: "cast publish ls", does: "Every page: slug, title, version, kind, views, open comments, gates, session" },
      { cmd: "cast publish versions <target>", does: "Version history with restore and compare hints" },
      { cmd: "cast publish rollback <target> <n>", does: "Restore version n as a new version" },
      { cmd: "cast publish comments <target>", does: <>Open comments; <C>--resolve &lt;id&gt;</C> or <C>--resolve-all</C></> },
      { cmd: "cast publish viewers <target>", does: "View count, and who opened it when the email gate is on" },
      { cmd: "cast publish links <target>", does: "Share, manage, edit, source and live URLs" },
      { cmd: "cast publish set <target> [flags]", does: "Change gates or title without republishing" },
      { cmd: "cast publish open <target>", does: "Print and open the share URL" },
      { cmd: "cast publish rm <target>", does: "Unpublish" },
      { cmd: "cast publish video", does: "The cast player guide" },
      { cmd: "cast image <file | url>", does: "One image, a stable link, ready markdown" },
    ],
  },
];

export function Reference() {
  const [tab, setTab] = useState(0);
  const g = GROUPS[tab];
  return (
    <Section
      id="reference"
      n="08"
      tone="sand"
      title="Command reference."
      lede={<>A <C>&lt;target&gt;</C> is a slug or the local path you published. Every command takes <C>--json</C>. Everything the page&apos;s owner panel does in the browser is also a command, so an agent never needs the browser to manage a page.</>}
    >
      <div className="flex gap-1 rounded-lg p-1 w-fit" role="tablist" style={{ backgroundColor: "rgba(0,43,54,.06)" }}>
        {GROUPS.map((x, i) => (
          <button
            key={x.name}
            type="button"
            role="tab"
            aria-selected={i === tab}
            onClick={() => setTab(i)}
            className="rounded-md px-4 h-9 font-mono text-[13px] font-semibold transition-colors"
            style={{ backgroundColor: i === tab ? SOL.base03 : undefined, color: i === tab ? SOL.base3 : SOL.base01 }}
          >
            {x.name}
          </button>
        ))}
      </div>
      <div key={g.name} className="mt-6 rounded-xl border overflow-hidden bg-white" style={{ borderColor: "rgba(88,110,117,.22)" }}>
        {g.rows.map((r, i) => (
          <div key={r.cmd} className="pb-anim pb-rise grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-8 gap-y-1 px-5 py-3.5 border-t first:border-t-0" style={{ borderColor: SOL.base2, ...{ ["--d" as string]: `${i * 0.03}s` } }}>
            <code className="font-mono text-[13px] font-semibold break-words" style={{ color: r.cmd.startsWith("-") ? CYAN : SOL.base03 }}>{r.cmd}</code>
            <span className="text-[14.5px] leading-6" style={{ color: SOL.base01 }}>{r.does}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
