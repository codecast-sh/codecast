// The marketing page's section for someone who does not write code: the
// hosted assistant in the family's look (@platform/design: paper, ink,
// Newsreader for the headline, Instrument Sans for the rest), so the step
// into /welcome reads as the same product rather than a hand-off to another.
// Three real errands from the asks /welcome offers, one way in, and where
// mail comes from. The nav's "For everyone" lands here (#everyone).
// Light on purpose, like everything the public pages import.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { track } from "../../lib/analytics";
import { useMountEffect } from "../../hooks/useMountEffect";
import { ASKS, ASSISTANT_HEADLINE, assistantPromise, useConnectAvailable } from "../simple/assistantPromise";
import { LANE_PATHS } from "../simple/lanePaths";

export const EVERYONE_ANCHOR = "everyone";

/** Errands that need nothing connected, worded to work as asked. */
const ERRANDS = [ASKS.planWeek, ASKS.sayNo, ASKS.compare];

const READ = "var(--pd-font-read, Georgia, serif)";
const UI = "var(--pd-font-ui, ui-sans-serif, system-ui)";

export function ForEveryone() {
  const mail = useConnectAvailable().available === true;
  // Arriving from another page's nav link (/#everyone): the router lands at
  // the top, so the section brings itself into view.
  useMountEffect(() => {
    if (window.location.hash === `#${EVERYONE_ANCHOR}`) {
      document.getElementById(EVERYONE_ANCHOR)?.scrollIntoView({ block: "start" });
    }
  });
  return (
    <section id={EVERYONE_ANCHOR} className="scroll-mt-20 px-6 py-16" style={{ background: "var(--pd-bg, #f6f1e7)", color: "var(--pd-ink, #1f1a14)", fontFamily: UI }}>
      <div className="mx-auto grid max-w-5xl gap-10 md:grid-cols-[1.1fr_1fr] md:items-center">
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
          {mail ? (
            <p className="mt-6 max-w-md text-[13px] leading-relaxed" style={{ color: "var(--pd-ink-faint, #8f8676)" }}>
              Mail and calendar come in through Whisk, our mail app, and the assistant asks before it sends anything.
            </p>
          ) : null}
        </div>
        <ul className="flex flex-col gap-3" aria-label="Things to ask">
          {ERRANDS.map((errand, i) => (
            <li
              key={errand}
              className="rounded-[12px] border px-5 py-4 text-[16px] leading-snug"
              style={{
                background: "var(--pd-bg-raised, #fdfbf6)",
                borderColor: "var(--pd-rule, #e6dccb)",
                boxShadow: "0 1px 2px rgba(32, 28, 23, 0.06)",
                fontFamily: READ,
                marginLeft: i === 1 ? 24 : 0,
              }}
            >
              &ldquo;{errand}&rdquo;
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
