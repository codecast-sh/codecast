// The way in for someone who does not write code: one link to /welcome, the
// hosted assistant's onboarding, said the same way on the marketing home page
// (in its first screen and again under the buttons) and signup. It sits beside the developer start rather than inside it, so
// the developer story stays whole and the second path still reads as a path.
// Light on purpose: the public pages import it, so it reaches neither the
// store nor the lane's model.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AssistantMark } from "./AssistantMark";
import { track } from "../../lib/analytics";
import { assistantInvite, useConnectAvailable } from "./assistantPromise";
import { LANE_PATHS } from "./lanePaths";

/** The question that names who the path is for. */
const WAY_IN_QUESTION = "Don't write code?";

/** `marketing` sits on the landing page's fixed Solarized light paper;
 *  `app` reads the themed `sol` tokens, as signup does. */
const TONES = {
  marketing:
    "border-[#e4ddc8] bg-[#fffcf4] text-[#586e75] hover:border-[#cb4b16]/50 hover:bg-[#fbf5e6] [--way-mark:#cb4b16] [--way-strong:#073642] [--way-paper:#fdf6e3]",
  app: "border-sol-border/70 bg-sol-bg-alt/40 text-sol-text-muted hover:border-sol-orange/50 hover:bg-sol-bg-alt [--way-mark:var(--sol-orange)] [--way-strong:var(--sol-text)] [--way-paper:var(--sol-bg)]",
} as const;

/** The family's interface face, so the way in reads as a different product
 *  from the developer copy set in mono around it. */
const WAY_FONT = { fontFamily: "var(--pd-font-ui, ui-sans-serif, system-ui, sans-serif)" } as const;

/** `compact` is one quiet pill rather than the card: the landing page's first
 *  screen, above the install command, where the card's weight would compete
 *  with the developer start. The card is two lines (who it is for, then what
 *  it does) with Get started as its one action. */
export function AssistantWayIn({ location, tone, compact = false }: { location: "landing_top" | "landing_hero" | "signup"; tone: keyof typeof TONES; compact?: boolean }) {
  const { available } = useConnectAvailable();
  const onClick = () => track("assistant_path_clicked", { location });
  if (compact) {
    return (
      <Link
        href={LANE_PATHS.welcome}
        onClick={onClick}
        className={`group inline-flex max-w-full items-center gap-2 rounded-full border py-1 pl-1.5 pr-3 text-left text-[14px] leading-snug transition-colors ${TONES[tone]}`}
        style={WAY_FONT}
      >
        <AssistantMark size={20} />
        {/* Each half is its own inline block, so a narrow screen breaks after
            the question and never strands one word of the invitation. */}
        <span className="min-w-0">
          <span className="inline-block font-semibold text-[var(--way-strong)]">{WAY_IN_QUESTION}</span>{" "}
          <span className="inline-block [text-wrap:balance]">{assistantInvite(available === true)}</span>
        </span>
        <ArrowRight aria-hidden size={14} className="shrink-0 text-[var(--way-mark)] transition-transform group-hover:translate-x-0.5" />
      </Link>
    );
  }
  return (
    <Link
      href={LANE_PATHS.welcome}
      onClick={onClick}
      className={`group flex w-full max-w-lg items-center gap-3.5 rounded-2xl border px-4 py-3 text-left leading-snug transition-colors ${TONES[tone]}`}
      style={WAY_FONT}
    >
      <AssistantMark size={36} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-[var(--way-strong)]">{WAY_IN_QUESTION}</span>
        <span className="block text-[13.5px]">{assistantInvite(available === true)}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-[14px] font-semibold text-[var(--way-mark)]">
        Get started
        <ArrowRight aria-hidden size={15} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
