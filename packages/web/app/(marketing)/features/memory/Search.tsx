"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Layer, Pane, Run, C, t, VIOLET } from "./kit";

/**
 * Layer 01: search with operators. Each chip is one operator with a real
 * query and output in the CLI's own format; the record they read is the same
 * one the hero drilled through.
 */

type Hit = { id: string; title: string; when: string; msgs: number; repo: string; quote?: { n: number; role: string; text: string } };
type Op = { op: string; says: string; query: string; found: string; hits: Hit[] };

const S = {
  maya: { id: "jx7m41c", title: "Add jitter to webhook backoff", when: "Oct 1", msgs: 96, repo: "~/src/payments" },
  sam: { id: "jx7k2qa", title: "Retry cap for failed webhooks", when: "Sep 18", msgs: 214, repo: "~/src/payments" },
  lee: { id: "jx7f9de", title: "Stripe webhook ingest", when: "Aug 30", msgs: 388, repo: "~/src/payments" },
};

const OPS: Op[] = [
  { op: "file:", says: "sessions that edited a file or folder", query: "cast search file:src/webhooks/retry.ts", found: "Found 3 sessions matching the filters", hits: [S.maya, S.sam, S.lee] },
  { op: "commit:", says: "the session that made a commit", query: "cast search commit:4b1c9e2", found: "Found 1 session matching the filters", hits: [S.sam] },
  { op: "pr:", says: "sessions linked to a pull request, then text inside them", query: 'cast search "pr:482 jitter"', found: "Found 1 match in 1 conversation", hits: [{ ...S.maya, quote: { n: 12, role: "user", text: "Full jitter, not equal jitter. Two workers restarting together must not retry in lockstep." } }] },
  { op: "label:", says: "sessions filed under one of your labels", query: 'cast search "label:payments after:7d"', found: "Found 1 session matching the filters", hits: [S.maya] },
  { op: "author:", says: "who ran the session (me, or a teammate's name)", query: 'cast search "author:sam retry cap"', found: "Found 1 match in 1 conversation", hits: [{ ...S.sam, quote: { n: 88, role: "user", text: "Cap it at 3. Stripe already retries for three days, so ours only covers our own outages." } }] },
  { op: "repo:", says: "the session's repository", query: 'cast search "repo:payments signature"', found: "Found 1 match in 1 conversation", hits: [{ ...S.lee, quote: { n: 47, role: "assistant", text: "Verifying the Stripe-Signature header against the raw body, before JSON parsing touches it." } }] },
  { op: "before:", says: "activity before a time; after: is the other side", query: 'cast search "ingest before:2026-09-01"', found: "Found 1 match in 1 conversation", hits: [{ ...S.lee, quote: { n: 3, role: "user", text: "Build the Stripe webhook ingest. Idempotent on event id." } }] },
];

function Header({ title }: { title: string }) {
  const head = `── ${title} `;
  return <>{t.head(head + "─".repeat(Math.max(4, 46 - head.length)))}{"\n"}</>;
}

function Result({ op }: { op: Op }) {
  return (
    <>
      <Run>{op.query}</Run>
      {t.dim("<SEARCHRESULTS>")}{"\n"}
      {op.found}{"\n\n"}
      {op.hits.map((h) => (
        <span key={h.id}>
          <Header title={h.title} />
          {t.id(h.id)} {t.dim("|")} {t.g("○ done")} {t.dim("|")} {h.when} {t.dim("|")} {h.msgs} msgs {t.dim("|")} {h.repo}{"\n"}
          {h.quote && <>{"\n  "}{t.y(`${h.quote.n}:`)} {t.dim(`[${h.quote.role}]`)} {t.ink(h.quote.text)}{"\n"}</>}
          {"\n"}
        </span>
      ))}
      {t.dim("To explore:")}{"\n"}
      {"  "}{t.v("cast read <id> <line>:<line>")}{t.dim("   # read message range")}{"\n"}
      {"  "}{t.v("cast diff <id>")}{t.dim("                 # files a session changed")}{"\n"}
      {t.dim("</SEARCHRESULTS>")}
    </>
  );
}

export function SearchLayer() {
  const [i, setI] = useState(0);
  const op = OPS[i];
  return (
    <Layer
      n="01"
      id="search"
      title={<>Search the work, not just the words</>}
      lede={
        <>
          <p>
            Every session records what it touched: the files it edited, the commits it made, the pull requests it is linked to, the repository it ran in, who ran it, and when. <C>cast search</C> turns each of those into an operator.
          </p>
          <p>
            With no text, an operator lists the matching sessions, newest matching change first. With text, it narrows where the text is searched. Combine them freely. The web app&apos;s search page reads the same query.
          </p>
          <OpTable />
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5 mb-4" role="tablist" aria-label="Search operators">
        {OPS.map((o, k) => {
          const on = k === i;
          return (
            <button
              key={o.op}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setI(k)}
              className="mm-chip font-mono text-[13px] px-3 py-1.5 rounded-md"
              style={{ backgroundColor: on ? VIOLET : SOL.base3, color: on ? SOL.base3 : SOL.base01, border: `1px solid ${on ? VIOLET : `color-mix(in srgb, ${VIOLET} 25%, transparent)`}` }}
            >
              {o.op}
            </button>
          );
        })}
      </div>
      <p className="font-mono text-[12.5px] mb-3" style={{ color: SOL.base01 }}>
        <span className="font-semibold" style={{ color: VIOLET }}>{op.op}</span> {op.says}
      </p>
      <Pane key={op.op} label="~/src/payments" className="mm-anim mm-open">
        <Result op={op} />
      </Pane>
      <div className="grid sm:grid-cols-2 gap-3 mt-5">
        <Flag f="-C 3" d="Show three messages either side of each match, so a hit arrives with its reasoning." />
        <Flag f="-u" d="Search only what people typed: the instructions and corrections, not the agents' replies." />
        <Flag f="--keyword / --semantic" d="Both run by default. Force one when you want an exact identifier or a loose idea." />
        <Flag f="--mine · -m sam · -g" d="Narrow to your sessions or a teammate's, or widen past this team to every team you belong to." />
      </div>
    </Layer>
  );
}

function Flag({ f, d }: { f: string; d: ReactNode }) {
  return (
    <div className="rounded-lg px-3.5 py-3" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
      <div className="font-mono text-[12.5px] font-semibold mb-1" style={{ color: SOL.base02 }}>{f}</div>
      <div className="text-[13.5px] leading-[1.5]" style={{ color: SOL.base01 }}>{d}</div>
    </div>
  );
}

function OpTable() {
  const rows: [string, string][] = [
    ["--label api", "label:api"],
    ["--mine", "author:me"],
    ["-m sam", "author:sam"],
    ["-s 7d", "after:7d"],
    ["-e 2026-09-01", "before:2026-09-01"],
  ];
  return (
    <div className="text-[14px]">
      <p className="mb-2" style={{ color: SOL.base01 }}>The flags you already know are the same operators:</p>
      <div className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 font-mono text-[12.5px]">
        {rows.map(([a, b]) => (
          <div key={a} className="contents">
            <span style={{ color: SOL.base02 }}>{a}</span>
            <span style={{ color: SOL.base1 }}>=</span>
            <span style={{ color: VIOLET }}>{b}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[13.5px]" style={{ color: SOL.base1 }}>Times read as <C>7d</C>, <C>2w</C>, <C>24h</C>, <C>yesterday</C> or a date.</p>
    </div>
  );
}
