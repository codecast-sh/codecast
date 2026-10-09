"use client";

// One agent feature, explained: its picture, the outcome in a sentence, what
// you will see and when agents use it, something to ask, where it shows in
// the app, and (folded) the exact text it installs. Opened from a card on the
// Agent features page, or from an upsell anywhere in the app via
// /agent-features?feature=<slug>.

import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { FEATURE_EXPLAINERS, type SnippetDescriptor } from "@codecast/shared/contracts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { hooksOfFeature } from "../../lib/harnessHooksView";
import { isRecentlyShipped } from "../../lib/newSnippets";
import { deepDiveForSnippet, featureHref } from "../../app/(marketing)/features/catalog";
import { FeatureVignette } from "./FeatureVignette";
import { featureIcon, featureTone } from "./featureLook";

export const STABLE_NAME = "Stable context";

export function FeatureDialog({
  slug,
  feature,
  control,
  setup,
  onClose,
}: {
  slug: string | null;
  /** The catalog entry; null for Stable context, which is not one. */
  feature: SnippetDescriptor | null;
  control: React.ReactNode;
  /** The one-time step on the machine a feature needs before agents can use it. */
  setup?: React.ReactNode;
  onClose: () => void;
}) {
  const e = slug ? FEATURE_EXPLAINERS[slug] : undefined;
  const router = useRouter();
  if (!slug || !e) return <Dialog open={false} />;
  const tone = featureTone(slug);
  const Icon = featureIcon(slug);
  const hooks = hooksOfFeature(slug);
  const deep = deepDiveForSnippet(slug);
  const name = feature?.name ?? STABLE_NAME;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col gap-0 overflow-hidden border-sol-border bg-sol-bg p-0">
        <div className="flex items-start gap-4 border-b border-sol-border px-6 pb-5 pt-6 pr-12">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${tone.tile}`}>
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold text-sol-text">
              {name}
              {feature && isRecentlyShipped(feature) && <NewPill />}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px] leading-snug text-sol-text-secondary">{e.pitch}</DialogDescription>
          </div>
          {control}
        </div>

        <div className="scrollbar-auto min-h-0 flex-1 overflow-y-auto">
          <FeatureVignette slug={slug} className="h-[210px] rounded-none border-0 border-b border-sol-border/50 text-[11px]" />

          {setup && <div className="border-b border-sol-border/50 px-6 py-5">{setup}</div>}

          <div className="grid gap-x-8 gap-y-6 px-6 py-6 sm:grid-cols-2">
            <ExplainList title="What you'll see" items={e.youSee} dot={tone.dot} />
            <ExplainList title="When agents use it" items={e.agentsUse} dot={tone.dot} />
          </div>

          <div className="mx-6 rounded-lg border border-sol-border/70 bg-sol-bg-alt/50 px-4 py-3">
            <div className="text-[11px] text-sol-text-dim">Try asking</div>
            <p className="mt-1 text-[13.5px] text-sol-text">&ldquo;{e.tryIt}&rdquo;</p>
          </div>

          {(e.surface || deep) && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 px-6 pt-5 text-xs">
              {e.surface && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    router.push(e.surface!.path);
                  }}
                  className={`inline-flex items-center gap-1 ${tone.text} hover:underline`}
                >
                  See it in {e.surface.label}
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              )}
              {deep && (
                <a href={featureHref(deep.slug)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sol-text-muted hover:text-sol-text">
                  The full tour of {deep.name}
                  <ArrowUpRight className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          <dl className="mx-6 mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 border-t border-sol-border/60 pt-5 text-[12px]">
            {feature ? (
              <>
                <DetailRow label="Install" mono>
                  cast install {feature.slug}
                  {feature.aliases?.length ? <span className="text-sol-text-dim"> (or {feature.aliases.join(", ")})</span> : null}
                </DetailRow>
                <DetailRow label="Writes to">{feature.writesTo}</DetailRow>
              </>
            ) : (
              <DetailRow label="Install" mono>cast stable solo | team | off</DetailRow>
            )}
            {hooks.map((h) => (
              <DetailRow key={h.file} label="Hook">
                {h.name} (~/.claude/hooks/{h.file}), added and removed with the switch
              </DetailRow>
            ))}
            {feature && <DetailRow label="Since">{feature.shipped}</DetailRow>}
          </dl>

          {feature?.section && (
            <details className="group/read mx-6 mb-6 mt-6">
              <summary className="cursor-pointer list-none text-xs font-medium text-sol-text-muted hover:text-sol-text">
                <span className="inline-block transition-transform group-open/read:rotate-90">›</span> Read exactly what your agent reads
              </summary>
              <div className="mt-3 rounded-lg border border-sol-border/70 bg-sol-bg-alt/40 px-5 py-4 text-[13px]">
                <MarkdownRenderer content={feature.section.body.trim().replace(/\n<!-- \/codecast-[^>]+-->\s*$/, "")} />
              </div>
            </details>
          )}
          {!feature?.section && <div className="h-6" />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExplainList({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  return (
    <div>
      <h3 className="mb-2.5 text-[13px] font-semibold text-sol-text">{title}</h3>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it} className="flex gap-2.5 text-[13px] leading-relaxed text-sol-text-secondary">
            <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailRow({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-sol-text-dim">{label}</dt>
      <dd className={`text-sol-text-secondary ${mono ? "font-mono" : ""}`}>{children}</dd>
    </>
  );
}

export function NewPill() {
  return (
    <span className="rounded-full border border-sol-cyan/30 bg-sol-cyan/10 px-1.5 py-px text-[10px] text-sol-cyan">New</span>
  );
}
