"use client";
// Placeholder for the Changes page until its components land
// (docs/proposals/changes-page.md T12, which owns and replaces this file).
// The route (app/changes/page.tsx) already gates it on a team with the
// changes flag on, so this only renders the enabled page.
import { useSearchParams } from "next/navigation";
import { changesDayLabel, localDay } from "../../lib/changesDay";

export function ChangesPage() {
  const searchParams = useSearchParams();
  const day = changesDayLabel(searchParams.get("d")) ?? changesDayLabel(localDay());
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-6">
        <h1 className="text-[20px] font-semibold text-sol-text">Changes</h1>
        <p className="mt-1 text-xs text-sol-text-dim">{day}</p>
      </div>
    </div>
  );
}
