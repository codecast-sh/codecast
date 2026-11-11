"use client";
// The head of a plan opened over the Plans list (components/PlanDetailPanel),
// both ways. Classic keeps its title row inside the panel's column, its ✕
// going back the way the person came (hooks/useNavTrail) as Modern's does; Modern
// draws the shared page header pinned at the top of the panel's scroller:
// the back control, the plan's place (Docs › Plans), its status and name,
// the share control and the close, which goes back the way the person came
// (hooks/useNavTrail).

import Link from "next/link";
import { X, type LucideIcon } from "lucide-react";
import { policyTeamOf } from "@codecast/shared/contracts";
import { Badge } from "./ui/badge";
import { ShareControl } from "./ShareControl";
import { PageHeader } from "./ui/page-header";
import { useNavClose, useNavCloseTarget } from "../hooks/useNavTrail";

type PlanHeadProps = {
  plan: { _id: string; short_id?: string; title: string; share_token?: string | null };
  status: { icon: LucideIcon; color: string; label: string };
  /** The share token as the store holds it (`undefined`: no store row). */
  storeShareToken: string | null | undefined;
  closeHref?: string;
};

function PlanShare({ plan, storeShareToken }: Pick<PlanHeadProps, "plan" | "storeShareToken">) {
  return (
            <ShareControl
              label="plan"
              path={`/plans/${plan.short_id}`}
              publicShare={{ kind: "plan", id: plan._id, token: storeShareToken !== undefined ? storeShareToken : plan.share_token, team: policyTeamOf("plans", plan as any) }}
            />
  );
}

/** Classic: the status icon, the title, the status, then share and close. */
export function PlanPanelTitleRow({ plan, status, storeShareToken, closeHref }: PlanHeadProps) {
  const StatusIcon = status.icon;
  const close = useNavCloseTarget(closeHref ?? "/plans");
  return (
        <div className="flex items-center gap-2.5 mb-2">
          <StatusIcon className={`w-5 h-5 flex-shrink-0 ${status.color}`} />
          <h1 className="min-w-0 break-words text-xl font-semibold text-sol-text">{plan.title}</h1>
          <Badge variant="outline" className={`flex-shrink-0 text-meta px-1.5 py-0 ${status.color} border-current/30`}>
            {status.label}
          </Badge>
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            <PlanShare plan={plan} storeShareToken={storeShareToken} />
            {closeHref && (
              <Link
                href={close.href}
                onClick={(e) => {
                  // A modified click keeps the link's own behaviour (a new tab).
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  close.close();
                }}
                aria-label="Close"
                title="Close"
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
              >
                <X className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>
  );
}

/** Modern: the shared page header, pinned while the plan scrolls under it. */
export function PlanPanelBar({ plan, status, storeShareToken, closeHref }: PlanHeadProps) {
  const StatusIcon = status.icon;
  const close = useNavClose(closeHref ?? "/plans");
  return (
    <PageHeader
      legacy={null}
      // Pinned while the plan scrolls under it (the header's own position is relative).
      className="!sticky top-0"
      data-page-head
      title={plan.title}
      glyph={<StatusIcon className={`size-4 ${status.color}`} aria-hidden />}
      status={<span className={`text-meta font-medium ${status.color}`}>{status.label}</span>}
      share={<>
        <PlanShare plan={plan} storeShareToken={storeShareToken} />
        {closeHref && (
          <button type="button" onClick={close} className="inline-flex size-7 items-center justify-center rounded-control text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text" title="Close" aria-label="Close">
            <X className="size-4" />
          </button>
        )}
      </>}
    />
  );
}
