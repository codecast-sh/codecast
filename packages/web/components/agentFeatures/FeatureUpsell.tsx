"use client";

// An offer to turn on one agent feature, placed where that feature would show
// up: the decision queue offers Decision queue, the pages gallery offers
// Publish. It appears only while every one of the person's machines has the
// feature off, says in a sentence what they would get here, turns it on for
// every online machine in one click, and goes away for good when declined
// (one decline per feature, shared with the new-features banner).

import { ArrowUpRight, Check, X } from "lucide-react";
import { FEATURE_EXPLAINERS } from "@codecast/shared/contracts";
import { useRouter } from "next/navigation";
import { useFeatureOffer } from "./useFeatureOffer";
import { FeatureVignette } from "./FeatureVignette";
import { agentFeatureHref } from "../../lib/agentFeatureHref";
import { featureIcon, featureTone } from "./featureLook";

export function FeatureUpsell({
  slug,
  reason,
  variant = "card",
  className = "",
}: {
  slug: string;
  /** What this feature would do on the surface showing the offer. Defaults
   *  to the feature's pitch. */
  reason?: string;
  /** `card` sits at the top of a page; `inline` is a strip inside another card;
   *  `quiet` is one muted line of prose under a message in a thread. */
  variant?: "card" | "inline" | "quiet";
  className?: string;
}) {
  const o = useFeatureOffer(slug);
  const router = useRouter();
  if (!o.feature || !(o.offer || o.turnedOn)) return null;

  const tone = featureTone(slug);
  const Icon = featureIcon(slug);
  const text = reason ?? FEATURE_EXPLAINERS[slug]?.pitch ?? o.feature.desc;
  const learn = () => router.push(agentFeatureHref(slug));
  const target = o.onlineCount === 1 ? "your online machine" : `your ${o.onlineCount} online machines`;

  const done = (
    <span className="inline-flex items-center gap-1.5 text-sol-green">
      <Check className="h-3.5 w-3.5" />
      On for {target}. Sessions you start from now on can use it.
    </span>
  );

  const actions = (
    <>
      <button
        type="button"
        onClick={o.turnOn}
        disabled={o.busy || o.onlineCount === 0}
        title={o.onlineCount === 0 ? "No machine is online to turn it on" : `Turns it on for ${target}`}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${tone.tile} hover:brightness-110`}
      >
        {o.busy ? "Turning on…" : "Turn on"}
      </button>
      <button type="button" onClick={learn} className="inline-flex items-center gap-0.5 text-xs text-sol-text-muted hover:text-sol-text">
        How it works
        <ArrowUpRight className="h-3 w-3" />
      </button>
    </>
  );

  const dismiss = !o.turnedOn && (
    <button
      type="button"
      onClick={o.dismiss}
      aria-label={`Not now: stop suggesting ${o.feature.name}`}
      title="Don't suggest this again"
      className="shrink-0 rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight/60 hover:text-sol-text"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );

  if (variant === "quiet") {
    const link = "transition-colors hover:text-sol-text";
    return (
      <p className={`group/offer text-[12px] leading-relaxed text-sol-text-dim ${className}`}>
        <Icon className={`mr-1.5 inline h-3 w-3 -translate-y-px ${tone.text} opacity-70`} />
        {o.turnedOn ? (
          <span className="text-sol-green">{o.feature.name} is on for {target}. Sessions you start from now on can use it.</span>
        ) : (
          <>
            {text}{" "}
            <button type="button" onClick={o.turnOn} disabled={o.busy || o.onlineCount === 0} className={`underline decoration-current/40 underline-offset-2 transition-colors hover:decoration-current ${tone.text} disabled:opacity-50`}>
              {o.busy ? "Turning on…" : `Turn on ${o.feature.name}`}
            </button>
            <span className="mx-1.5 text-sol-border">·</span>
            <button type="button" onClick={learn} className={link}>How it works</button>
            <span className="mx-1.5 text-sol-border">·</span>
            <button type="button" onClick={o.dismiss} aria-label={`Not now: stop suggesting ${o.feature.name}`} className={link}>
              Not now
            </button>
          </>
        )}
      </p>
    );
  }

  if (variant === "inline") {
    return (
      <div className={`flex items-center gap-2 border-t border-sol-border bg-sol-bg-alt px-3 py-1.5 text-[11px] leading-snug text-sol-text-muted ${className}`}>
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone.text}`} />
        <span className="min-w-0 flex-1">{o.turnedOn ? done : text}</span>
        {!o.turnedOn && <span className="flex shrink-0 items-center gap-2.5">{actions}</span>}
        {dismiss}
      </div>
    );
  }

  return (
    <div
      role="note"
      aria-label={`Agent feature: ${o.feature.name}`}
      className={`animate-fadeSlideIn flex items-stretch gap-4 rounded-lg border border-sol-border/70 bg-sol-bg p-3 pr-2 ${className}`}
    >
      <FeatureVignette slug={slug} className="hidden h-[132px] w-[240px] shrink-0 sm:block" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-sol-text-muted">
          <Icon className={`h-3.5 w-3.5 ${tone.text}`} />
          Agent feature <span className="text-sol-text-dim">·</span> <span className="font-medium text-sol-text">{o.feature.name}</span>
        </div>
        <p className="text-[13px] leading-snug text-sol-text">{text}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs">{o.turnedOn ? done : actions}</div>
      </div>
      <div className="flex flex-col">{dismiss}</div>
    </div>
  );
}
