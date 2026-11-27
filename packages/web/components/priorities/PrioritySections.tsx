// /priorities' sections as lib/prioritySections buildSections lays them out:
// a heading per workspace or person, a subheading per person or workspace
// inside it, each group's priorities, and "Done and set aside n" as each
// group's last row. Faces, workspace icons and ranks share the rank column;
// every heading and priority title starts at the text edge after it
// (lib/priorityList RANK_COLUMN, TEXT_EDGE).
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { PriorityRow } from "../../lib/priorities";
import { RANK_COLUMN, TEXT_EDGE, type ListLayout } from "../../lib/priorityList";
import type { Sections } from "../../lib/prioritySections";
import { AvatarImg } from "../../lib/avatarCache";
import { cn } from "../../lib/utils";
import { WorkspaceMark } from "./PrioritiesToolbar";

/** Draws one priority: `face` puts its owner's face after the rank (Workspace grouping). */
export type BlockOf = (row: PriorityRow, opts?: { face?: boolean }) => ReactNode;

const LABEL = "text-mark font-semibold uppercase tracking-wide text-sol-text-dim";

/** A person's face, the size of a rank's digit. */
export function Face({ name, label = name, image, size = 16 }: { name: string; label?: string; image?: string | null; size?: number }) {
  const initial = name.trim()[0]?.toUpperCase() || "?";
  const box = { width: size, height: size };
  return (
    <span data-face={label} title={label} className="flex shrink-0">
      <AvatarImg
        src={image}
        alt={name}
        style={box}
        className="rounded-full object-cover"
        fallback={<span style={box} className="flex items-center justify-center rounded-full border border-sol-border/60 bg-sol-bg-highlight text-mark font-medium leading-none text-sol-text-muted">{initial}</span>}
      />
    </span>
  );
}

/** A priority's owner's face; the viewer's reads "You". */
export function OwnerFace({ row }: { row: Pick<PriorityRow, "owner" | "owner_image" | "mine"> }) {
  return <Face name={row.owner} label={row.mine ? "You" : row.owner} image={row.owner_image} />;
}

/**
 * A heading: its mark centred in the rank column, its name at the text edge.
 * `top` is a section's own heading (a workspace, or a person grouped first);
 * otherwise it is a group's small-caps label inside one.
 */
function Heading({ mark, name, count, top, layout, ...data }: { mark: ReactNode; name: string; count?: number; top?: boolean; layout: ListLayout } & Record<`data-${string}`, string>) {
  return (
    <div {...data} className={cn(RANK_COLUMN[layout], "items-center", top ? "border-b border-sol-border/60 pb-2 pt-1" : "pt-2")}>
      <span className="flex justify-center">{mark}</span>
      <span className={cn("flex min-w-0 items-baseline gap-2", top ? "text-ui font-semibold text-sol-text" : LABEL)}>
        <span data-heading-name className="truncate">{name}</span>
        {count != null && <span className="shrink-0 font-normal tabular-nums text-sol-text-dim">{count}</span>}
      </span>
    </div>
  );
}

/** The last row of a group: its done and set-aside priorities, folded, starting at the text edge. */
function PastFold({ rows, block, layout, face }: { rows: PriorityRow[]; block: BlockOf; layout: ListLayout; face?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div data-past-priorities>
      <div className={cn(TEXT_EDGE[layout], "py-1")}>
        <button
          type="button"
          data-past-toggle
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn("-ml-1 inline-flex min-h-6 items-center gap-1 rounded px-1 hover:bg-sol-bg-alt hover:text-sol-text [@media(pointer:coarse)]:min-h-11", LABEL)}
        >
          Done and set aside <span className="font-normal tabular-nums">{rows.length}</span>
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
        </button>
      </div>
      {open && <ol>{rows.map((r) => block(r, { face }))}</ol>}
    </div>
  );
}

/** One person's priorities in one workspace: in rank order, then the fold. */
function Group({ active, past, block, layout }: { active: PriorityRow[]; past: PriorityRow[]; block: BlockOf; layout: ListLayout }) {
  return (
    <>
      <ol data-active>{active.map((r) => block(r))}</ol>
      <PastFold rows={past} block={block} layout={layout} />
    </>
  );
}

const WORKSPACE_ICON = "size-3.5 shrink-0";

export function PrioritySections({ sections, block, layout, headings, people }: {
  sections: Sections;
  block: BlockOf;
  layout: ListLayout;
  /** More than one workspace shown: each gets its heading (pageControls showSectionHeadings). */
  headings: boolean;
  /** A teammate is on the page: each person in a workspace gets their label. */
  people: boolean;
}) {
  // Between sections only: the toolbar is the list's first child, so the first section is the first of its type.
  const gap = "mt-6 first-of-type:mt-0";
  if (sections.groupBy === "workspace") {
    return (
      <>
        {sections.sections.map((s) => (
          <section key={s.key} data-section={s.key} className={gap}>
            {headings && <Heading data-section-heading={s.key} top layout={layout} mark={<WorkspaceMark workspace={s.key} className={WORKSPACE_ICON} />} name={s.name} count={s.active.length} />}
            <ol data-active>{s.active.map(({ row }) => block(row, { face: true }))}</ol>
            <PastFold rows={s.past} block={block} layout={layout} face />
          </section>
        ))}
      </>
    );
  }
  if (sections.groupBy === "person_workspace") {
    return (
      <>
        {sections.sections.map((p) => {
          const first = p.workspaces[0]?.active[0] ?? p.workspaces[0]?.past[0];
          const count = p.workspaces.reduce((n, w) => n + w.active.length, 0);
          return (
            <section key={p.user_id} data-section={p.user_id} className={gap}>
              <Heading data-person-heading={p.user_id} top layout={layout} mark={first ? <OwnerFace row={first} /> : null} name={p.mine ? "You" : p.owner} count={count} />
              {p.workspaces.map((w) => (
                <div key={w.key} data-priority-group={`${p.user_id}/${w.key}`}>
                  <Heading data-workspace-label={w.key} layout={layout} mark={<WorkspaceMark workspace={w.key} className={WORKSPACE_ICON} />} name={w.name} />
                  <Group active={w.active} past={w.past} block={block} layout={layout} />
                </div>
              ))}
            </section>
          );
        })}
      </>
    );
  }
  return (
    <>
      {sections.sections.map((s) => (
        <section key={s.key} data-section={s.key} className={gap}>
          {headings && <Heading data-section-heading={s.key} top layout={layout} mark={<WorkspaceMark workspace={s.key} className={WORKSPACE_ICON} />} name={s.name} count={s.people.reduce((n, p) => n + p.active.length, 0)} />}
          {s.people.map((p) => {
            const first = p.active[0] ?? p.past[0];
            return (
              <div key={p.user_id} data-priority-group={`${s.key}/${p.user_id}`}>
                {people && <Heading data-person-label={p.user_id} layout={layout} mark={first ? <OwnerFace row={first} /> : null} name={p.mine ? "You" : p.owner} />}
                <Group active={p.active} past={p.past} block={block} layout={layout} />
              </div>
            );
          })}
        </section>
      ))}
    </>
  );
}
