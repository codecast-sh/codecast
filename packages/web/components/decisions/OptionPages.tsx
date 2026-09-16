"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Columns2 } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useTrackedStore, type SessionDecisionItem } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { CONVEX_URL } from "../../lib/convexUrl";
import { openBrowserPane } from "../../lib/stage";
import { optionPageSlugs } from "../../lib/decisionQueue";
import "./decisions.css";

const api = _api as any;

// Option pages (docs/architecture/the-line.md L6): when an option carries a
// published page, the options compare as a row of cards above the option
// list: the page's thumbnail and title, the option's number and label, open
// in a pane, open in full. The card is also the answer target: its number
// answers that option while the decision is pending and the viewer may
// answer. Side by side where the width allows, stacked on a phone (the css).
export function OptionPages({
  decision,
  answerable = false,
  onAnswer,
  chosen,
}: {
  decision: Pick<SessionDecisionItem, "options" | "status">;
  answerable?: boolean;
  onAnswer?: (index: number) => void;
  chosen?: ReadonlySet<number>;
}) {
  if (optionPageSlugs(decision.options).length === 0) return null;
  const canAnswer = answerable && decision.status === "pending" && !!onAnswer;
  return (
    <div className="decision-option-pages" data-option-pages>
      {decision.options.map((o, i) =>
        o.page_slug ? (
          <OptionPageCard
            key={i}
            index={i}
            label={o.label.replace(" (Recommended)", "")}
            slug={o.page_slug}
            picked={!!chosen?.has(i)}
            onAnswer={canAnswer ? () => onAnswer!(i) : undefined}
          />
        ) : null,
      )}
    </div>
  );
}

// The serving origin frames the page (the same source PublishedPageEmbed
// uses): it arrives under its own sandbox CSP. The share page is the full
// open; the thumb endpoint serves the capture `cast publish` took.
function pageFrameSrc(slug: string): string {
  return `${CONVEX_URL}/cli/a/${slug}`;
}
function pageShareUrl(slug: string): string {
  return `https://codecast.sh/a/${slug}`;
}

function OptionPageCard({ index, label, slug, picked, onAnswer }: { index: number; label: string; slug: string; picked: boolean; onAnswer?: () => void }) {
  // The artifacts store row (fed by listForWeb) names the page when the
  // viewer owns it or a teammate shared it; getShared is the enrichment for
  // a page outside that set. The frame and the thumb need neither.
  const s = useTrackedStore([
    (st) => (st as any).artifacts?.[slug]?.title,
    (st) => (st as any).artifacts?.[slug]?.version,
  ]);
  const row = (s as any).artifacts?.[slug] as { title?: string; version?: number } | undefined;
  const { data: meta } = useQueryNoThrow(api.artifacts.getShared, row ? "skip" : { slug });
  const title: string = row?.title ?? meta?.title ?? "Published page";
  const version = row?.version ?? meta?.version ?? 0;
  const [thumbFailed, setThumbFailed] = useState(false);
  const openPane = () => openBrowserPane({ kind: "url", url: pageFrameSrc(slug) });

  return (
    <div className="decision-option-page" data-option-page={index} data-picked={picked ? "true" : "false"}>
      <div className="flex items-center gap-2 px-3 py-2 min-w-0">
        {onAnswer ? (
          <button
            type="button"
            onClick={onAnswer}
            data-option-answer={index}
            className="w-6 h-6 shrink-0 rounded-full border border-sol-yellow/50 text-sol-text font-mono text-[11px] flex items-center justify-center hover:bg-sol-yellow hover:text-sol-bg transition-colors"
            title={`Answer with option ${index + 1}`}
          >
            {index + 1}
          </button>
        ) : (
          <span className={`w-6 h-6 shrink-0 rounded-full border flex items-center justify-center font-mono text-[11px] ${picked ? "border-sol-green text-sol-green" : "border-sol-border text-sol-text-dim"}`}>
            {picked ? <Check className="w-3.5 h-3.5" /> : index + 1}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-sol-text" title={label}>{label}</span>
      </div>
      <button type="button" onClick={openPane} className="decision-option-page-thumb" title="Open beside your work, as a pane" aria-label={`Open ${title} in a pane`}>
        {thumbFailed ? (
          <span className="w-full h-full flex items-center justify-center text-sol-text-dim font-mono text-2xl select-none">{"</>"}</span>
        ) : (
          <img src={`${CONVEX_URL}/cli/a/${slug}?thumb=1&r=v${version}`} alt="" loading="lazy" onError={() => setThumbFailed(true)} />
        )}
      </button>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] min-w-0">
        <span className="min-w-0 flex-1 truncate text-sol-text-muted" title={title}>{title}</span>
        <button type="button" onClick={openPane} className="flex items-center gap-1 text-sol-text-dim hover:text-sol-blue transition-colors shrink-0" title="Open in a pane">
          <Columns2 className="w-3 h-3" />pane
        </button>
        <a href={pageShareUrl(slug)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sol-text-dim hover:text-sol-blue transition-colors shrink-0 no-underline" title="Open in full">
          full<ArrowUpRight className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
