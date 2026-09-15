"use client";
// The charter block at the top of a project page and a plan page
// (docs/architecture/org-staffing.md S7): goal, success metrics, priority,
// owner role, non goals, risks, and the advisory budget line. Every field
// edits inline; the caller turns each patch into the store action
// (updateProject / updatePlan) so the row paints first and the dispatch side
// effect carries the write. Empty: one line and the ask to the chief of staff.
import { useState } from "react";
import Link from "next/link";
import { Compass, Flag, ListChecks, Ban, AlertTriangle, Coins, Plus, X, Sparkles, UserRoundPlus } from "lucide-react";
import { cn } from "../../lib/utils";
import { InlineEdit } from "../org/OrgScopePanel";
import { OwnerRoleChip, PriorityPill } from "./CharterChips";
import {
  chiefOfStaffOf,
  cleanBudget,
  composeCharterHref,
  formatTokens,
  hasCharter,
  parseTokens,
  PRIORITY_META,
  type CharterFields,
  type CharterKind,
  type CharterPatch,
  type OrgRoles,
} from "./charterMeta";

export type CharterBlockProps = {
  kind: CharterKind;
  /** The project's or plan's title: the ask to the chief of staff names it. */
  title: string;
  charter: CharterFields;
  canEdit: boolean;
  onChange: (patch: CharterPatch) => void;
  /** The workspace's roles (useOrgRoles): the owner chip and the chief of
   *  staff come from them. Null while they load. */
  roles: OrgRoles;
  /** A project with no owner: the chip opens the hire form prefilled. */
  onHire?: () => void;
  /** Why no owner can be picked here (no hire path and no role to offer):
   *  the chip renders disabled and says so. */
  ownerBlockedReason?: string;
  className?: string;
};

/** One list of the charter (metrics, non goals, risks). Each row is an inline
 *  edit; saving a row empty removes it; the last row adds. */
function ListField({ label, singular, icon: Icon, items, canEdit, onChange, placeholder, marker }: {
  label: string;
  /** Names one row for a screen reader: "Success metric 2", "Risk 1". */
  singular: string;
  icon: typeof Flag;
  items: string[];
  canEdit: boolean;
  onChange: (next: string[]) => void;
  placeholder: string;
  marker: (i: number) => React.ReactNode;
}) {
  if (items.length === 0 && !canEdit) return null;
  const setAt = (i: number, v: string) => {
    const next = items.slice();
    if (v) next[i] = v; else next.splice(i, 1);
    onChange(next);
  };
  return (
    <div className="min-w-0" data-charter-list={label}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
        {items.length > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{items.length}</span>}
      </div>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={`${i}:${item}`} className="group/item flex items-start gap-2 text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>
            <span className="mt-[5px] shrink-0">{marker(i)}</span>
            <InlineEdit value={item} canEdit={canEdit} onSave={(v) => setAt(i, v)} className="text-[12.5px] flex-1" ariaLabel={`${singular} ${i + 1}`} />
            {canEdit && (
              <button type="button" onClick={() => setAt(i, "")} className="mt-[3px] shrink-0 opacity-0 group-hover/item:opacity-60 focus-visible:opacity-100 hover:!opacity-100 transition-opacity" aria-label={`Remove ${singular} ${i + 1}`} style={{ color: "var(--sol-text-dim)" }}>
                <X className="w-3 h-3" />
              </button>
            )}
          </li>
        ))}
        {canEdit && (
          <li className="flex items-start gap-2 text-[12px]" style={{ color: "var(--sol-text-dim)" }}>
            <Plus className="w-3 h-3 mt-[5px] shrink-0" />
            <InlineEdit value="" canEdit placeholder={placeholder} onSave={(v) => { if (v) onChange([...items, v]); }} className="text-[12px] flex-1" ariaLabel={`New ${singular.toLowerCase()}`} />
          </li>
        )}
      </ul>
    </div>
  );
}

/** Advisory: what the owner role should spend on this line per day. Written
 *  on the project; the role's caps still bound the actual spend. */
function BudgetLine({ budget, canEdit, onChange }: { budget: CharterFields["budget"]; canEdit: boolean; onChange: (b: NonNullable<CharterFields["budget"]> | null) => void }) {
  const tokens = budget?.tokens_per_day;
  const hands = budget?.hands_per_day;
  if (!tokens && !hands && !canEdit) return null;
  // Built through the server's own cleaner so the draft is the echo's JSON
  // (sorted keys, as Convex returns them): the field lock compares by
  // JSON.stringify, and a budget whose second field was appended after the
  // first would otherwise hold a different key order and not retire.
  const set = (patch: Partial<NonNullable<CharterFields["budget"]>>) => onChange(cleanBudget({ ...(budget ?? {}), ...patch }) ?? null);
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] flex-wrap" style={{ color: "var(--sol-text-muted)" }} data-charter-budget>
      <Coins className="w-3 h-3 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
      <span style={{ color: "var(--sol-text-dim)" }}>Budget</span>
      <InlineEdit
        canEdit={canEdit}
        value={tokens ? formatTokens(tokens) : ""}
        placeholder="tokens"
        ariaLabel="Budget tokens per day"
        onSave={(v) => { if (!v) set({ tokens_per_day: undefined }); else { const n = parseTokens(v); if (n !== null) set({ tokens_per_day: n }); } }}
        className="text-[11.5px] font-mono !w-auto"
      />
      <span style={{ color: "var(--sol-text-dim)" }}>tokens/day ·</span>
      <InlineEdit
        canEdit={canEdit}
        value={hands ? String(hands) : ""}
        placeholder="hands"
        ariaLabel="Budget hands per day"
        onSave={(v) => { if (!v) set({ hands_per_day: undefined }); else { const n = Number(v); if (Number.isInteger(n) && n >= 0) set({ hands_per_day: n }); } }}
        className="text-[11.5px] font-mono !w-auto"
      />
      <span style={{ color: "var(--sol-text-dim)" }}>hands/day</span>
      <span className="text-[10px] uppercase tracking-[0.08em] ml-1 px-1.5 h-[16px] inline-flex items-center rounded border" style={{ color: "var(--sol-text-dim)", borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)" }} title="A guide for the owner role and the chief of staff; the role's own caps still bound the spend">advisory</span>
    </div>
  );
}

export function CharterBlock({ kind, title, charter, canEdit, onChange, roles, onHire, ownerBlockedReason, className }: CharterBlockProps) {
  // "No charter yet" until someone opens the fields or a value lands.
  const [opened, setOpened] = useState(false);
  const filled = hasCharter(charter);
  const chief = chiefOfStaffOf(roles);
  const accent = charter.priority ? PRIORITY_META[charter.priority].color : "color-mix(in srgb, var(--sol-border) 70%, transparent)";

  // The ask always goes to /org with the composer prefilled: with a chief of
  // staff the draft request lands in its standing session; without one the
  // staffing pane opens on "Hire a Chief of Staff" and the compose text
  // survives the hire, so the ask arrives once the seat exists. The label
  // names what the click does: ask the seat by handle when one exists, hire
  // one when the roles are known and none holds it. With no roles to read
  // (still loading, or the tree on screen is another workspace's) the seat
  // is unknown, not absent, so the label stays the plain ask.
  const rolesLoaded = roles != null;
  const hires = rolesLoaded && !chief;
  const askLabel = chief ? `Ask @${chief.handle} to draft one` : hires ? "Hire a Chief of Staff to draft one" : "Ask the Chief of Staff to draft one";
  const AskIcon = hires ? UserRoundPlus : Sparkles;
  if (!filled && !opened) {
    return (
      <div className={cn("flex items-center gap-2 text-[12px] flex-wrap", className)} data-charter="empty">
        <Compass className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
        <span style={{ color: "var(--sol-text-dim)" }}>No charter yet.</span>
        <Link
          href={composeCharterHref(title)}
          className="inline-flex items-center gap-1 font-medium hover:underline"
          style={{ color: "var(--sol-cyan)" }}
          title={chief ? `Sends "draft a charter for ${title}" to @${chief.handle}` : hires ? "Opens the org page on hiring a Chief of Staff; the draft request follows the hire" : "Sends the draft request to the Chief of Staff"}
          data-charter-ask={chief ? "ask" : hires ? "hire" : "unknown"}
        >
          <AskIcon className="w-3 h-3" /> {askLabel}
        </Link>
        {canEdit && (
          <button type="button" onClick={() => setOpened(true)} className="hover:underline" style={{ color: "var(--sol-text-dim)" }}>or write it</button>
        )}
      </div>
    );
  }

  const metrics = charter.success_metrics ?? [];
  const nonGoals = charter.non_goals ?? [];
  const risks = charter.risks ?? [];
  const showOwner = kind === "project" ? true : !!charter.owner_role_id || canEdit;

  return (
    <section
      className={cn("relative rounded-lg border pl-4 pr-3.5 py-3", className)}
      style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", background: "color-mix(in srgb, var(--sol-card) 60%, transparent)" }}
      data-charter={kind}
      aria-label="Charter"
    >
      {/* The rule carries the priority colour: the block reads at a glance from across the room. */}
      <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: accent }} />

      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>
          <Compass className="w-3 h-3" /> Charter
        </span>
        <PriorityPill priority={charter.priority} onChange={canEdit ? (p) => onChange({ priority: p }) : undefined} />
        {showOwner && (
          <OwnerRoleChip
            roles={roles}
            ownerRoleId={charter.owner_role_id}
            onChange={canEdit ? (id) => onChange({ owner_role_id: id }) : undefined}
            onHire={canEdit && kind === "project" ? onHire : undefined}
            blockedReason={ownerBlockedReason}
          />
        )}
        {kind === "project" && (
          <div className="ml-auto">
            <BudgetLine budget={charter.budget} canEdit={canEdit} onChange={(b) => onChange({ budget: b })} />
          </div>
        )}
      </div>

      <div data-charter-goal>
        <InlineEdit
          value={charter.goal ?? ""}
          canEdit={canEdit}
          multiline
          placeholder={kind === "project" ? "What this project is for, in one paragraph a new hire could act on." : "What this plan delivers and how you will know it landed."}
          onSave={(v) => onChange({ goal: v })}
          ariaLabel="Goal"
          className="text-[13.5px] leading-relaxed whitespace-pre-wrap"
          style={{ color: "var(--sol-text)" }}
        />
      </div>

      {(metrics.length + nonGoals.length + risks.length > 0 || canEdit) && (
        <div className="mt-3 grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <ListField
            label="Success metrics"
            singular="Success metric"
            icon={ListChecks}
            items={metrics}
            canEdit={canEdit}
            onChange={(next) => onChange({ success_metrics: next })}
            placeholder="Add a metric"
            marker={() => <span className="inline-block w-3 h-3 rounded-[3px] border" style={{ borderColor: "color-mix(in srgb, var(--sol-green) 70%, transparent)" }} />}
          />
          <ListField
            label="Non goals"
            singular="Non goal"
            icon={Ban}
            items={nonGoals}
            canEdit={canEdit}
            onChange={(next) => onChange({ non_goals: next })}
            placeholder="Add a non goal"
            marker={() => <Ban className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />}
          />
          {kind === "project" && (
            <ListField
              label="Risks"
              singular="Risk"
              icon={AlertTriangle}
              items={risks}
              canEdit={canEdit}
              onChange={(next) => onChange({ risks: next })}
              placeholder="Add a risk"
              marker={() => <AlertTriangle className="w-3 h-3" style={{ color: "var(--sol-orange)" }} />}
            />
          )}
        </div>
      )}
    </section>
  );
}
