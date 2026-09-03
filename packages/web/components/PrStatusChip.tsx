// The pull request a session is shepherding, as one chip.
//
// The inbox card and the thread state panel above the composer both show it,
// so it lives here once. The number says which PR; the word says what the PR
// is waiting for, and its color says whether that is the reader's problem.
// Green means nothing is blocking, red means something broke, orange and
// yellow mean it is waiting on a person or on CI.
import React from "react";
import Link from "next/link";
import { GitPullRequest } from "lucide-react";
import { accentSoft, accentVar, prPath, shepherdStyle } from "../lib/externalEvents";
import type { PrStatus } from "../store/inboxStore";

export function PrStatusChip({
  status,
  size = "card",
  className = "",
}: {
  status: PrStatus | null | undefined;
  size?: "card" | "panel";
  className?: string;
}) {
  if (!status) return null;
  const { label, accent } = shepherdStyle(status.state);
  const href = prPath({ repository: status.repository, number: status.number });
  const text = size === "panel" ? "text-[10px]" : "text-[9px]";
  const body = (
    <>
      <GitPullRequest className={size === "panel" ? "w-3 h-3" : "w-2.5 h-2.5"} />
      <span className="tabular-nums">#{status.number}</span>
      <span className="opacity-80">{label}</span>
    </>
  );
  const chip = `inline-flex items-center gap-0.5 px-1 py-0 rounded border font-semibold ${text} ${className}`;
  const style = {
    color: accentVar(accent),
    background: accentSoft(accent, 12),
    borderColor: accentSoft(accent, 35),
  };
  const title = `${status.repository} #${status.number}${status.title ? ` — ${status.title}` : ""}`;
  if (!href) {
    return (
      <span className={chip} style={style} title={title}>
        {body}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${chip} hover:brightness-110`}
      style={style}
      title={title}
      // The chip sits inside a clickable session card; opening the PR must not
      // also open the session behind it.
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </Link>
  );
}
