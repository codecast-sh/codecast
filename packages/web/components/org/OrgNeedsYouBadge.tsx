"use client";
// The rail Org row's count: the number of rows in Waits on you, plain text in
// orange, the one colour that means "it waits on you". Zero shows nothing.
import { memo } from "react";
import { useOrgNeedsYouCount } from "./useNeedsYou";

export const OrgNeedsYouBadge = memo(function OrgNeedsYouBadge() {
  const n = useOrgNeedsYouCount();
  if (n <= 0) return null;
  return (
    <span
      data-org-nav-count={n}
      title={`${n} wait${n === 1 ? "s" : ""} on you`}
      className="px-1 text-[11.5px] font-semibold tabular-nums"
      style={{ color: "var(--sol-orange)" }}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
});
