// The marketing page's section for someone who does not write code: the
// hosted assistant in the family's look (@platform/design: paper, ink,
// Newsreader for the headline, Instrument Sans for the rest), so the step
// into /welcome reads as the same product rather than a hand-off to another.
// One way in, three real errands that start /welcome with that ask, and a
// small picture of what a conversation looks like. The nav's "For everyone"
// lands here (#everyone). Light on purpose, like everything the public pages
// import.
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { track } from "../../lib/analytics";
import { useMountEffect } from "../../hooks/useMountEffect";
import { ASKS, ASSISTANT_HEADLINE, assistantPromise, useConnectAvailable } from "../simple/assistantPromise";
import { LANE_PATHS, welcomeAskPath } from "../simple/lanePaths";
import { AssistantMark } from "../simple/AssistantMark";

export const EVERYONE_ANCHOR = "everyone";

/** Errands that need nothing connected, worded to work as asked. */
const ERRANDS = [ASKS.planWeek, ASKS.sayNo, ASKS.compare];

const READ = "var(--pd-font-read, Georgia, serif)";
const UI = "var(--pd-font-ui, ui-sans-serif, system-ui)";
/** The marketing bands' cream above and below, which the section fades from. */
const MARKETING_CREAM = "#fdf6e3";

export function ForEveryone() {
  const mail = useConnectAvailable().available === true;
  // Arriving from another page's nav link (/#everyone): the router lands at
  // the top, and the section mounts before the page above it has its height,
  // so it brings itself into view once layout has settled.
  useMountEffect(() => {
    if (window.location.hash !== `#${EVERYONE_ANCHOR}`) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const id = window.setTimeout(() => {
      document.getElementById(EVERYONE_ANCHOR)?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }, 120);
    return () => window.clearTimeout(id);
  });
  return (
    <section
      id={EVERYONE_ANCHOR}
      className="scroll-mt-20 px-6 py-20"
      style={{
        // The family's paper, eased in and out of the cream bands around it.
        background: `linear-gradient(${MARKETING_CREAM}, var(--pd-bg, #f6f1e7) 64px, var(--pd-bg, #f6f1e7) calc(100% - 64px), ${MARKETING_CREAM})`,
        color: "var(--pd-ink, #1f1a14)",
        fontFamily: UI,
      }}
    >
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1.05fr_1fr] md:items-center">
        <div>
          <p className="mb-3 text-[14px] font-medium" style={{ color: "var(--pd-ink-muted, #6b6152)" }}>For people who don&apos;t write code</p>
          <h2 className="text-[34px] leading-[1.12] sm:text-[42px]" style={{ fontFamily: READ, fontWeight: 500 }}>{ASSISTANT_HEADLINE}</h2>
          <p className="mt-4 max-w-md text-[16px] leading-relaxed" style={{ color: "var(--pd-ink-muted, #6b6152)" }}>{assistantPromise(mail)}</p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <Link
              href={LANE_PATHS.welcome}
              onClick={() => track("assistant_path_clicked", { location: "landing_everyone" })}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] px-5 text-[15px] font-semibold transition-[filter] hover:brightness-110"
              style={{ background: "var(--pd-accent, #c93a0e)", color: "var(--pd-accent-ink, #fdfbf6)" }}
            >
              Get started <ArrowRight aria-hidden size={16} />
            </Link>
            <span className="text-[13px]" style={{ color: "var(--pd-ink-faint, #8f8676)" }}>Free to start. Nothing to install.</span>
          </div>
          <p className="mt-8 text-[13px] font-medium" style={{ color: "var(--pd-ink-faint, #8f8676)" }}>Or start with one of these</p>
          <ul className="mt-2 flex flex-col gap-1.5" aria-label="Things to ask">
            {ERRANDS.map((errand) => (
              <li key={errand}>
                <Link
                  href={welcomeAskPath(errand)}
                  onClick={() => track("assistant_path_clicked", { location: "landing_everyone_ask" })}
                  className="group inline-flex items-baseline gap-2 text-[16px] leading-snug underline-offset-4 hover:underline"
                  style={{ fontFamily: READ, color: "var(--pd-ink, #1f1a14)", textDecorationColor: "var(--pd-rule-strong, #d3c6af)" }}
                >
                  <span>&ldquo;{errand}&rdquo;</span>
                  <ArrowRight aria-hidden size={14} className="shrink-0 translate-y-[2px] transition-transform group-hover:translate-x-0.5" style={{ color: "var(--pd-accent, #c93a0e)" }} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <ConversationPicture />
      </div>
    </section>
  );
}

/** A still of a hosted conversation: the person's ask, the assistant's short
 *  answer in the reading face, and the approval card it raises before it
 *  changes anything. It needs nothing connected, so it promises nothing the
 *  deployment cannot do yet. Drawn, not captured, so it never goes stale. */
function ConversationPicture() {
  return (
    <figure
      aria-label="A conversation with the assistant"
      className="rounded-[16px] border p-5 sm:p-6"
      style={{ background: "var(--pd-bg-raised, #fdfbf6)", borderColor: "var(--pd-rule, #e6dccb)", boxShadow: "0 18px 40px -24px rgba(32, 28, 23, 0.35)" }}
    >
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-[12px] px-3.5 py-2.5 text-[14px] leading-snug" style={{ background: "color-mix(in srgb, var(--pd-ink, #1f1a14) 7%, var(--pd-bg, #f6f1e7))" }}>
          {ASKS.mondays}
        </p>
      </div>
      <div className="mt-5 flex gap-3">
        <AssistantMark size={26} />
        <div className="min-w-0 flex-1">
          <p className="text-[16.5px] leading-[1.55]" style={{ fontFamily: READ }}>
            Happy to. I&apos;ll nudge you each Monday morning with a short list to start from.
          </p>
          <div className="mt-4 rounded-[10px] border p-3.5" style={{ borderColor: "var(--pd-rule, #e6dccb)", background: "var(--pd-bg, #f6f1e7)" }}>
            <p className="text-[13.5px] font-semibold">Set up a routine?</p>
            <p className="mt-1 text-[13px] leading-snug" style={{ color: "var(--pd-ink-muted, #6b6152)" }}>
              Every Monday at 9:00 AM: remind you to plan the week.
            </p>
            <div className="mt-3 flex gap-2" aria-hidden>
              <span className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[13px] font-semibold" style={{ background: "var(--pd-accent, #c93a0e)", color: "var(--pd-accent-ink, #fdfbf6)" }}>
                <Check size={14} /> Yes
              </span>
              <span className="inline-flex h-8 items-center rounded-[8px] border px-3 text-[13px] font-medium" style={{ borderColor: "var(--pd-rule, #e6dccb)" }}>
                Not now
              </span>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
