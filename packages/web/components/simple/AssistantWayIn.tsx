// The way in for someone who does not write code: one quiet link to /welcome,
// the hosted assistant's onboarding, under the signup form. The developer
// pages do not carry it; a non-developer campaign link (/everyone) has its own
// page. Light on purpose: the public pages import it, so it reaches neither
// the store nor the lane's model.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AssistantMark } from "./AssistantMark";
import { track } from "../../lib/analytics";
import { assistantInvite, useConnectAvailable } from "./assistantPromise";
import { LANE_PATHS } from "./lanePaths";

/** The family's interface face, so the way in reads as a different product
 *  from the developer copy around it. */
const WAY_FONT = { fontFamily: "var(--pd-font-ui, ui-sans-serif, system-ui, sans-serif)" } as const;

export function AssistantWayIn() {
  const { available } = useConnectAvailable();
  return (
    <Link
      href={LANE_PATHS.welcome}
      onClick={() => track("assistant_path_clicked", { location: "signup" })}
      className="group inline-flex max-w-full items-center gap-2 text-left text-[13px] leading-snug text-sol-text-dim transition-colors hover:text-sol-text-muted"
      style={WAY_FONT}
    >
      <AssistantMark size={16} />
      {/* Each half is its own inline block, so a narrow screen breaks after
          the question and never strands one word of the invitation. */}
      <span className="min-w-0">
        <span className="inline-block font-medium">Don&apos;t write code?</span>{" "}
        <span className="inline-block [text-wrap:balance]">{assistantInvite(available === true)}</span>
      </span>
      <ArrowRight aria-hidden size={13} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
