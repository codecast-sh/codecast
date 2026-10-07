"use client";
// /share/doc/<token>: a doc set as a document someone sat down to read. The
// body in reading type, its headings anchored and listed in an outline rail
// on wide screens, the doc's own timeline under it.
import { useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { docTypeLabel, stripTitleHeading } from "@codecast/shared/docs";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { MarkdownBlocks } from "../../../../components/tools/MarkdownRenderer";
import { MD_COMPONENTS } from "../../../../lib/markdownComponents";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { Pill, Section, Rows, Row, ShareHead, SharedObjectPage } from "../../SharedObjectPage";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as any).props?.children);
}

const slug = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";

const heading = (Tag: "h1" | "h2" | "h3") =>
  function ShareHeading({ children }: { children?: ReactNode }) {
    return (
      <Tag id={slug(textOf(children))} className={`share-h share-${Tag}`}>
        {children}
      </Tag>
    );
  };

// Module level, so MarkdownBlocks' memo holds.
const READING: Components = { ...MD_COMPONENTS, h1: heading("h1"), h2: heading("h2"), h3: heading("h3") };

type OutlineEntry = { depth: number; text: string; id: string };

/** The headings of a markdown body, outside code fences, as the outline lists them. */
function outlineOf(markdown: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    // The heading's text as it renders: emphasis marks, code ticks and link
    // targets drop, underscores inside names stay.
    const text = m[2]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/(^|\s)[*_](\S.*?\S|\S)[*_](?=\s|$)/g, "$1$2");
    out.push({ depth: m[1].length, text, id: slug(text) });
  }
  return out;
}

function Outline({ entries }: { entries: OutlineEntry[] }) {
  const [active, setActive] = useState<string | null>(null);
  useWatchEffect(() => {
    const els = entries.map((e) => document.getElementById(e.id)).filter(Boolean) as HTMLElement[];
    if (els.length === 0) return;
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) visible.set(r.target.id, r.isIntersecting);
        const first = els.find((el) => visible.get(el.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-72px 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [entries]);
  const top = Math.min(...entries.map((e) => e.depth));
  return (
    <nav className="share-outline" aria-label="Outline">
      <span>On this page</span>
      {entries.map((e, i) => (
        <a key={i} href={`#${e.id}`} title={e.text} data-depth={e.depth - top + 2} data-active={active === e.id ? "" : undefined}>
          {e.text}
        </a>
      ))}
    </nav>
  );
}

export default function SharedDocClient() {
  return (
    <SharedObjectPage<any>
      kind="doc"
      query={(api as any).docs.getShared}
      noun="doc"
      aside={(doc) => {
        const entries = outlineOf(stripTitleHeading(doc.content));
        return entries.length >= 3 ? <Outline entries={entries} /> : null;
      }}
    >
      {(doc) => (
        <>
          <ShareHead
            badges={
              <>
                <Pill tone="blue">{docTypeLabel(doc.doc_type)}</Pill>
                {doc.labels?.map((l: string) => (
                  <Pill key={l} quiet>
                    {l}
                  </Pill>
                ))}
              </>
            }
            title={doc.title}
            user={doc.user}
            at={doc.created_at}
            meta={
              doc.updated_at && doc.updated_at - doc.created_at > 60_000 ? (
                <span title={formatDateFull(doc.updated_at)}>updated {formatDateSmart(doc.updated_at)}</span>
              ) : null
            }
          />
          <div className="share-prose">
            <div className="prose max-w-none">
              <MarkdownBlocks content={stripTitleHeading(doc.content)} components={READING} />
            </div>
          </div>
          {doc.entries?.length > 0 && (
            <div style={{ marginTop: 56 }}>
              <Section title="Timeline" count={doc.entries.length}>
                <Rows>
                  {doc.entries.map((e: any, i: number) => (
                    <Row key={i} trail={<span title={formatDateFull(e.timestamp)}>{formatDateSmart(e.timestamp)}</span>} note={e.type}>
                      {e.content}
                    </Row>
                  ))}
                </Rows>
              </Section>
            </div>
          )}
        </>
      )}
    </SharedObjectPage>
  );
}
