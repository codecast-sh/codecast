"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { isMac } from "@/shortcuts";
import { Layer, Pane, Run, C, t, VIOLET } from "./kit";
import { ForScripts, Shot } from "../kit";

/**
 * Layer 01: search with operators. The Search page leads; each chip below is
 * one operator with a real query, shown the way an agent reads it from the
 * CLI. The record they read is the same one the hero drilled through.
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
            Every session records what it touched: the files it edited, the commits it made, the pull requests it is linked to, the repository it ran in, who ran it, and when. The Search page turns each of those into an operator you type into the box: <C>file:</C>, <C>commit:</C>, <C>pr:</C>, <C>label:</C>, <C>author:</C>, <C>repo:</C>, <C>after:</C>, <C>before:</C>.
          </p>
          <p>
            Open it from anywhere with <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">K</KeyCap> then <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap>. With no text, an operator lists the matching sessions, newest matching change first. With text, it narrows where the text is searched. The URL keeps the whole query, so a narrowed view is a link you can send.
          </p>
        </>
      }
    >
      <Shot
        className="mb-5"
        src="/features/memory/search-page.webp"
        alt="Codecast's Search page: a search box reading Search sessions with phrases, file:, pr:, commit:, filters for Scope (Everyone, Only mine), Match in (Everything, My prompts), Time (All time, 7d, 30d, 90d) and Sort (Recent, Relevant), and operator chips file:, commit:, pr:, label:, author:, repo:, after:, before:"
        width={1600}
        height={760}
        caption="The Search page before you type. Each chip drops its operator into the box."
      />
      <div className="grid sm:grid-cols-2 gap-3 mb-10">
        <Flag f="Everyone · Only mine" d="Your team's shared sessions, or just your own." />
        <Flag f="Everything · My prompts" d="Search only what people typed: the instructions and corrections, not the agents' replies." />
        <Flag f="All time · 7d · 30d · 90d" d="How far back to look." />
        <Flag f="Recent · Relevant" d="Newest first, or best match first. Keyword and meaning-based search both run either way." />
      </div>
      <ForScripts note="Your agents run the same query with cast search before they start a task. Pick an operator to see what it returns.">
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
      </ForScripts>
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
