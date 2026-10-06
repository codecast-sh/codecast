// The way in for someone who does not write code: one link to /welcome, the
// hosted assistant's onboarding, said the same way on the marketing home page
// (in its first screen and again under the buttons) and signup. It sits beside the developer start rather than inside it, so
// the developer story stays whole and the second path still reads as a path.
// Light on purpose: the public pages import it, so it reaches neither the
// store nor the lane's model.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { track } from "../../lib/analytics";
import { assistantInvite, useConnectAvailable } from "./assistantPromise";
import { LANE_PATHS } from "./lanePaths";

/** The question that names who the path is for. */
export const WAY_IN_QUESTION = "Don't write code?";

/** `marketing` sits on the landing page's fixed Solarized light paper;
 *  `app` reads the themed `sol` tokens, as signup does. */
const TONES = {
  marketing:
    "border-[#e4ddc8] bg-[#fdf6e3] text-[#586e75] hover:border-[#cb4b16]/50 hover:bg-[#f7efd9] [--way-mark:#cb4b16] [--way-strong:#073642]",
  app: "border-sol-border/70 bg-sol-bg-alt/40 text-sol-text-muted hover:border-sol-orange/50 hover:bg-sol-bg-alt [--way-mark:var(--sol-orange)] [--way-strong:var(--sol-text)]",
} as const;

/** `compact` is one quiet line rather than the pill: the landing page's
 *  first screen, under the install command, where the pill's weight would
 *  compete with the developer start. */
export function AssistantWayIn({ location, tone, compact = false }: { location: "landing_top" | "landing_hero" | "signup"; tone: keyof typeof TONES; compact?: boolean }) {
  const { available } = useConnectAvailable();
  const mark = compact ? "h-3 w-3 border-2" : "h-[18px] w-[18px] border-[3px]";
  return (
    <Link
      href={LANE_PATHS.welcome}
      onClick={() => track("assistant_path_clicked", { location })}
      className={`group inline-flex max-w-full items-center text-left leading-snug transition-colors ${
        compact
          ? `gap-2 rounded-full border px-3 py-1 text-[13px] ${TONES[tone]}`
          : `gap-3 rounded-3xl border py-2 pl-2.5 pr-4 text-[14px] ${TONES[tone]}`
      }`}
    >
      {/* The assistant's ring mark, as /welcome draws it. */}
      <span aria-hidden className={`${mark} shrink-0 rounded-full border-[var(--way-mark)]`} />
      <span className="min-w-0">
        <span className="font-semibold text-[var(--way-strong)]">{WAY_IN_QUESTION}</span>{" "}
        <span>{assistantInvite(available === true)}</span>
      </span>
      <ArrowRight aria-hidden size={compact ? 14 : 16} className="shrink-0 text-[var(--way-mark)] transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
