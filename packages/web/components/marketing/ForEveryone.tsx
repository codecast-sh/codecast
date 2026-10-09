// The marketing page's section for someone who does not write code: the
// hosted assistant in the family's look (@platform/design: paper, ink,
// Newsreader for the headline, Instrument Sans for the rest), so the step
// into /welcome reads as the same product rather than a hand-off to another.
// One way in, three real errands that start /welcome with that ask, and a
// small picture of what a conversation looks like. It is the whole page of
// the non-developer door (/?for=assistant, which /everyone redirects to); the
// developer home page does not show it. Light on purpose, like everything the
// public pages import.
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { track } from "../../lib/analytics";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useRef, useState } from "react";
import { ASKS, ASSISTANT_HEADLINE, assistantPromise, useConnectAvailable } from "../simple/assistantPromise";
import { AssistantPrivacyNote } from "../simple/AssistantPrivacyNote";
import { APPROVAL_ANSWERS, approvalButtonLabel, routineYesWords } from "@codecast/shared/contracts/assistant";
import { stepAsk } from "@platform/assistant/steps";
import { LANE_PATHS, welcomeAskPath } from "../simple/lanePaths";
import { AssistantMark } from "../simple/AssistantMark";

/** Errands that need nothing connected, worded to work as asked. */
const ERRANDS = [ASKS.sayNo, ASKS.compare, ASKS.trip];

const READ = "var(--pd-font-read, Georgia, serif)";
const UI = "var(--pd-font-ui, ui-sans-serif, system-ui)";

export function ForEveryone() {
  const mail = useConnectAvailable().available === true;
  return (
    <section
      className="px-6 pt-12 pb-24"
      style={{
        background: "var(--pd-bg, #f6f1e7)",
        color: "var(--pd-ink, #1f1a14)",
        fontFamily: UI,
      }}
    >
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1.05fr_1fr] md:items-center">
        <div>
          {/* Who is talking, before the headline speaks as "I". */}
          <p className="mb-3 text-[14px] font-medium" style={{ color: "var(--pd-ink-muted, #6b6152)" }}>
            <span style={{ color: "var(--pd-ink, #1f1a14)" }}>The Codecast assistant</span>, for people who don&apos;t write code
          </p>
          <h2 className="text-[34px] leading-[1.12] sm:text-[42px]" style={{ fontFamily: READ, fontWeight: 500 }}>{ASSISTANT_HEADLINE}</h2>
          <p className="mt-4 max-w-md text-[16px] leading-relaxed" style={{ color: "var(--pd-ink-muted, #6b6152)" }}>
            {/* What works today, said once; mail's arrival is /welcome's to
                say, where connecting is offered and Whisk is named. */}
            {assistantPromise(mail)}
          </p>
          <AssistantPrivacyNote mail={mail} className="mt-3 max-w-md text-[13.5px] leading-relaxed" style={{ color: "var(--pd-ink-faint, #8f8676)" }} />
          <GetStarted className="mt-7" location="landing_everyone" />
          <p className="mt-8 text-[13px] font-medium" style={{ color: "var(--pd-ink-faint, #8f8676)" }}>Or start with one of these</p>
          <ul className="mt-2 flex flex-col gap-1.5" aria-label="Things to ask">
            {ERRANDS.map((errand) => (
              <li key={errand}>
                <Link
                  href={welcomeAskPath(errand)}
                  onClick={() => track("assistant_path_clicked", { location: "landing_everyone_ask" })}
                  className="group grid grid-cols-[1fr_auto] items-start gap-2 text-[16px] leading-snug underline-offset-4 hover:underline"
                  style={{ fontFamily: READ, color: "var(--pd-ink, #1f1a14)", textDecorationColor: "var(--pd-rule-strong, #d3c6af)" }}
                >
                  {/* A fixed two-column grid: the arrow sits at the top right
                      of every errand, one line or two, so the three line up. */}
                  <span>&ldquo;{errand}&rdquo;</span>
                  <ArrowRight aria-hidden size={14} className="mt-[5px] shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color: "var(--pd-accent, #c93a0e)" }} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <ConversationPicture />
      </div>
      {/* The section ends on its own way in, so a reader who scrolls past the
          still is asked once more before the page turns to developers. */}
      <div className="mx-auto mt-16 flex max-w-5xl flex-col items-center gap-5 text-center">
        <p className="text-[24px] leading-snug" style={{ fontFamily: READ, fontWeight: 500 }}>Hand it the next thing on your list.</p>
        <GetStarted location="landing_everyone_end" centered />
      </div>
    </section>
  );
}

/** The foot of the assistant's door, where the page ends: pricing and
 *  privacy, and a small way over to the developer page for someone who came
 *  in the wrong door. Nothing about installing follows the promise that
 *  nothing needs installing. */
export function EveryoneFooter() {
  const link = "underline-offset-4 hover:underline";
  return (
    <footer className="px-6 pb-12" style={{ background: "var(--pd-bg, #f6f1e7)", color: "var(--pd-ink-faint, #8f8676)", fontFamily: UI }}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 border-t pt-6 text-[13.5px]" style={{ borderColor: "var(--pd-rule, #e6dccb)" }}>
        <Link href="/pricing?for=assistant" className={link}>Pricing</Link>
        <Link href="/privacy" className={link}>Privacy</Link>
        <Link href="/" className={`${link} ml-auto`}>Are you a developer? See Codecast for teams</Link>
      </div>
    </footer>
  );
}

/** The section's one way in, with what it costs to try. */
function GetStarted({ className, location, centered }: { className?: string; location: string; centered?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-4 ${centered ? "justify-center" : ""} ${className ?? ""}`}>
      <Link
        href={LANE_PATHS.welcome}
        onClick={() => track("assistant_path_clicked", { location })}
        className="inline-flex h-11 items-center gap-2 rounded-[10px] px-5 text-[15px] font-semibold transition-[filter] hover:brightness-110"
        style={{ background: "var(--pd-accent, #c93a0e)", color: "var(--pd-accent-ink, #fdfbf6)" }}
      >
        Get started <ArrowRight aria-hidden size={16} />
      </Link>
      <span className="text-[13px]" style={{ color: "var(--pd-ink-faint, #8f8676)" }}>Free to start. Nothing to install.</span>
    </div>
  );
}

/** The drawn card's routine, worded by the real card's own helpers: the
 *  question is the step's ask (stepAsk) and the yes line is routineYesWords,
 *  so the promise and the product name the first approval the same way. */
const PICTURE_ROUTINE = { name: "schedule_routine", input: { title: "Plan the week" } };
const PICTURE_SUMMARY = "Every Monday at 9:00 AM I'll remind you to plan the week, with a short list to start from.";
const PICTURE_YES = routineYesWords(true);

/** A part of the still before and after its entrance: 8px down and clear,
 *  then in place over 240ms, ease-out. Delays stagger the parts by 120ms. */
const ENTER = "opacity-0 translate-y-2 transition-[opacity,transform] duration-[240ms] ease-out group-data-[in]:opacity-100 group-data-[in]:translate-y-0 motion-reduce:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none";

/** A still of a hosted conversation: the person's ask, the assistant's short
 *  answer in the reading face, and the approval card it raises before it
 *  changes anything. It needs nothing connected, so it promises nothing the
 *  deployment cannot do yet. Drawn, not captured, so it never goes stale. */
function ConversationPicture() {
  // One entrance, the first time the still scrolls into view: the ask, then
  // the reply, then the card, each rising 8px (ENTER below). Reduced motion
  // shows it whole.
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  useMountEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        io.disconnect();
      }
    }, { threshold: 0.35 });
    io.observe(el);
    // A page that never reports the still in view (a background tab, a
    // capture) must not leave it faded, where it reads as disabled.
    const shown = window.setTimeout(() => setInView(true), 1500);
    return () => {
      io.disconnect();
      window.clearTimeout(shown);
    };
  });
  return (
    <figure
      ref={ref}
      data-in={inView ? "" : undefined}
      aria-label="A conversation with the assistant"
      className="group rounded-[16px] border p-5 sm:p-6"
      style={{ background: "var(--pd-bg-raised, #fdfbf6)", borderColor: "var(--pd-rule, #e6dccb)", boxShadow: "0 18px 40px -24px rgba(32, 28, 23, 0.35)" }}
    >
      <div className={`flex justify-end ${ENTER}`}>
        <p className="max-w-[85%] rounded-[12px] px-3.5 py-2.5 text-[14px] leading-snug" style={{ background: "color-mix(in srgb, var(--pd-ink, #1f1a14) 7%, var(--pd-bg, #f6f1e7))" }}>
          {ASKS.mondays}
        </p>
      </div>
      <div className={`mt-5 flex gap-3 ${ENTER} delay-[120ms]`}>
        <AssistantMark size={26} />
        <div className="min-w-0 flex-1">
          <p className="text-[16.5px] leading-[1.55]" style={{ fontFamily: READ }}>
            Happy to. Say yes and it starts Monday.
          </p>
          <div className={`mt-4 rounded-[10px] border p-3.5 ${ENTER} delay-[240ms]`} style={{ borderColor: "var(--pd-rule, #e6dccb)", background: "var(--pd-bg, #f6f1e7)" }}>
            <p className="text-[13.5px] font-semibold">{`${stepAsk(PICTURE_ROUTINE)}?`}</p>
            <p className="mt-1.5 text-[13px] leading-snug" style={{ color: "var(--pd-ink-muted, #6b6152)" }}>
              {PICTURE_SUMMARY}
            </p>
            <p className="mt-1.5 text-[12px] leading-snug" style={{ color: "var(--pd-ink-faint, #8f8676)" }}>
              {PICTURE_YES}
            </p>
            <div className="mt-3 flex gap-2" aria-hidden>
              <span className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[13px] font-semibold" style={{ background: "var(--pd-accent, #c93a0e)", color: "var(--pd-accent-ink, #fdfbf6)" }}>
                <Check size={14} /> {approvalButtonLabel(APPROVAL_ANSWERS.approve)}
              </span>
              <span className="inline-flex h-8 items-center rounded-[8px] border px-3 text-[13px] font-medium" style={{ borderColor: "var(--pd-rule, #e6dccb)" }}>
                {approvalButtonLabel(APPROVAL_ANSWERS.decline)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
