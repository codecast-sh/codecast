"use client";
// The proposal ledger's change chips: a status that moves and a list that
// gains entries, each on the wash of what goes and what comes.
import type { ChangeField } from "@codecast/shared/contracts/orgChangeWords";
import { cn } from "../../lib/utils";
import { CHIP, MUTED, RED, SOFT, statusLook, STRUCK, type RecordKind } from "./ledgerLook";

/** What a status becomes, on a green wash with the record's own glyph. Null for a word no vocabulary knows. */
export function StatusTo({ record, status, className }: { record?: RecordKind; status: string; className?: string }) {
  const now = statusLook(record, status);
  if (!now) return null;
  return (
    <ins className={cn(CHIP, "bg-[color-mix(in_srgb,var(--sol-green)_16%,transparent)] font-semibold text-[color:var(--ink-green)]", className)} data-diff="added">
      <now.Icon className={cn("h-3.5 w-3.5 shrink-0", now.color)} />
      {now.label}
    </ins>
  );
}

/** A status that moves, the thing a person approves: what it leaves struck
 *  on a red wash, what it becomes on a green one, each with the record's own
 *  status glyph, at the size of the sentence. */
export function StatusMove({ field, record }: { field: ChangeField; record?: RecordKind }) {
  const was = field.before && !field.before.none ? statusLook(record, field.before.text) : null;
  const now = field.after && !field.after.none ? statusLook(record, field.after.text) : null;
  if (!now) return null;
  const chip = cn(CHIP, "text-[13.5px] leading-[22px]");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-status-move>
      {was && (
        <>
          <del className={cn(chip, "bg-[color-mix(in_srgb,var(--sol-red)_12%,transparent)]", RED)} data-diff="removed">
            <was.Icon className={cn("h-3.5 w-3.5 shrink-0 opacity-70", was.color)} />
            <span className={STRUCK}>{was.label}</span>
          </del>
        </>
      )}
      {/* The arrow wraps with what it points at, never left at a line's end. */}
      <span className="inline-flex items-center gap-x-2 whitespace-nowrap">
        {was && <><span aria-hidden className={cn("font-medium", MUTED)}>→</span><span className="sr-only">becomes</span></>}
        <StatusTo record={record} status={field.after!.text} className="text-[13.5px] leading-[22px]" />
      </span>
    </span>
  );
}

/** A list that gains entries: the kept names, then the new ones behind a quiet plus. */
export function Added({ field }: { field: ChangeField }) {
  const before = new Set((field.before?.items ?? []).map((x) => x.toLowerCase()));
  const kept = (field.after?.items ?? []).filter((x) => before.has(x.toLowerCase()));
  const added = (field.after?.items ?? []).filter((x) => !before.has(x.toLowerCase()));
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {kept.length > 0 && <span className={SOFT}>{kept.join(", ")}</span>}
      {added.map((x) => <ins key={x} className={cn(CHIP, "bg-[color-mix(in_srgb,var(--sol-green)_14%,transparent)] px-1.5 py-0 font-medium text-[color:var(--ink-green)]")} data-diff="added"><span aria-hidden>+</span>{x}</ins>)}
    </span>
  );
}
