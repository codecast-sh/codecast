"use client";
// The right side of an initiative's page
// (docs/architecture/initiatives-projects-role-page.md I1 "The page"), in the
// contract's order: what it is for, the projects that carry it, what the owner
// said and when, and the initiatives under it. One scroll, no tabs: a person
// should be able to say what the company is trying to reach, who drives it,
// how it is going and which projects carry it without opening anything else.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, FolderKanban, Pencil, Plus, X } from "lucide-react";
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_UPDATE_HEALTHS, type InitiativeRow, type InitiativeUpdateHealth, type InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useInitiativeProjects } from "../../hooks/useInitiativeProjects";
import { useInitiativeUpdates } from "../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { initiativeHref, newInitiativeKey, projectTrouble, subInitiatives } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { ProjectLeadChip } from "../charter/ProjectLeadChip";
import { FilterOptionList } from "../FilterDropdown";
import { ProjectCard } from "../identity/RoleScopeView";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { HEALTH_COLOR, HealthChip, INITIATIVE_ACCENT, OwnerChip, StatusGlyph } from "./InitiativeAtoms";
import { ProjectInitiatives } from "./ProjectInitiatives";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.target_date ?? ""}|${(p.risks ?? []).length}`;

export function InitiativePanel({ initiative, all, now, onClose, closeLabel }: {
  initiative: InitiativeRow;
  all: InitiativeRow[];
  now: number;
  /** Present when the panel sits beside a conversation and can be put away. */
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="h-full flex flex-col min-h-0" data-initiative-panel={initiative.short_id || initiative._id}>
      {onClose && (
        <div className="shrink-0 flex items-center justify-between h-9 pl-4 pr-1.5 border-b" style={{ borderColor: HAIRLINE }}>
          <span className="text-[12px] font-semibold">Initiative</span>
          <button type="button" onClick={onClose} className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label={closeLabel} title={closeLabel} data-initiative-panel-close>
            {closeLabel === "Back to the conversation" ? <ChevronDown className="w-4 h-4" /> : <X className="w-4 h-4" />}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-7" data-initiative-scroll>
        <Description initiative={initiative} />
        <Projects initiative={initiative} now={now} />
        <Updates initiative={initiative} now={now} />
        <SubInitiatives rows={subInitiatives(all, initiative._id)} now={now} />
      </div>
    </div>
  );
}

function Section({ name, label, count, action, children }: { name: string; label: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-initiative-section={name}>
      <div className="flex items-center gap-2 mb-2.5 min-h-[24px]">
        <h2 className="text-[12.5px] font-semibold tracking-tight">{label}</h2>
        {count ? <span className="text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{count}</span> : null}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function GhostButton({ icon: Icon, children, onClick, ...rest }: { icon: any; children: ReactNode; onClick?: () => void } & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" onClick={onClick} className="h-6 inline-flex items-center gap-1 px-2 rounded-md text-[11.5px] font-medium hover:bg-sol-bg-highlight/70 transition-colors" style={{ color: "var(--sol-text-muted)" }} {...rest}>
      <Icon className="w-3 h-3" /> {children}
    </button>
  );
}

// ------------------------------------------------------------ description

/** Purpose, scope and context. Edited in place; the text moves on the page in
 *  the same tick and the write rides `updateInitiative`. */
function Description({ initiative }: { initiative: InitiativeRow }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next !== (initiative.description ?? "")) useInboxStore.getState().updateInitiative(initiative._id, { description: next || null });
    setDraft(null);
  };
  return (
    <Section name="description" label="What it is for" action={draft === null ? <GhostButton icon={Pencil} onClick={() => setDraft(initiative.description ?? "")} data-initiative-edit-description="">{initiative.description ? "Edit" : "Write"}</GhostButton> : undefined}>
      {draft !== null ? (
        <div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setDraft(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}
            rows={6}
            placeholder="The purpose, what is in scope and what is not, and the context a newcomer needs."
            className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-sol-text-dim focus:border-sol-magenta/60"
            style={{ borderColor: HAIRLINE }}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setDraft(null)} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
            <button type="button" onClick={save} className="h-7 px-3 rounded-md text-[12px] font-medium" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }}>Save</button>
          </div>
        </div>
      ) : initiative.description ? (
        <MarkdownRenderer content={initiative.description} className="text-[13px] leading-relaxed" />
      ) : (
        <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>Nobody has said what this is for yet.</p>
      )}
    </Section>
  );
}

// --------------------------------------------------------------- projects

function Projects({ initiative, now }: { initiative: InitiativeRow; now: number }) {
  const cards = useInitiativeProjects(initiative);
  const workspaceProjects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const byId = useMemo(() => new Map(workspaceProjects.map((p) => [p._id, p])), [workspaceProjects]);
  const options = useMemo(
    () => [...workspaceProjects].sort((a, b) => a.title.localeCompare(b.title)).map((p) => ({ key: p._id, label: p.title, icon: FolderKanban })),
    [workspaceProjects],
  );
  const toggle = (next: string) => {
    const before = new Set(initiative.project_ids);
    const after = new Set(next ? next.split(",") : []);
    const store = useInboxStore.getState();
    for (const id of after) if (!before.has(id)) store.addInitiativeProject(initiative._id, id);
    for (const id of before) if (!after.has(id)) store.removeInitiativeProject(initiative._id, id);
  };
  const hidden = initiative.project_ids.length - cards.length;
  return (
    <Section
      name="projects"
      label="Projects"
      count={initiative.project_ids.length}
      action={
        <Popover>
          <PopoverTrigger asChild><span><GhostButton icon={Plus} data-initiative-projects-edit="">{initiative.project_ids.length ? "Change" : "Add a project"}</GhostButton></span></PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-1 max-h-80 overflow-y-auto bg-sol-bg border border-sol-border shadow-xl">
            <FilterOptionList options={options} value={initiative.project_ids.join(",")} multi onChange={toggle} />
          </PopoverContent>
        </Popover>
      }
    >
      {cards.length === 0 ? (
        <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>No project carries this yet. An initiative is reached through its projects: add the ones that contribute to it.</p>
      ) : (
        <div className="space-y-2.5">
          {cards.map((p) => {
            const row = byId.get(p.id);
            const trouble = row ? projectTrouble(row, p, now) : null;
            return (
              <div key={p.id} data-initiative-project={p.id}>
                <ProjectCard p={p} lead={<ProjectLeadChip projectId={p.id} size="xs" />} initiative={<ProjectInitiatives projectId={p.id} size="xs" label="Also in" except={initiative._id} />} />
                {/* The project's own word, beside the owner's, so the two can disagree in plain sight. */}
                {trouble && <p className="mt-1 pl-3 text-[11px]" style={{ color: "var(--sol-yellow)" }} data-initiative-project-trouble>This project is {trouble}.</p>}
              </div>
            );
          })}
        </div>
      )}
      {hidden > 0 && <p className="mt-2 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{hidden} more {hidden === 1 ? "project is" : "projects are"} outside what you can read.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- updates

function Updates({ initiative, now }: { initiative: InitiativeRow; now: number }) {
  const updates = useInitiativeUpdates(initiative._id);
  const [writing, setWriting] = useState(false);
  return (
    <Section name="updates" label="Updates" count={updates.length} action={!writing ? <GhostButton icon={Plus} onClick={() => setWriting(true)} data-initiative-update-open="">Update</GhostButton> : undefined}>
      {writing && <UpdateForm initiative={initiative} onDone={() => setWriting(false)} />}
      {updates.length === 0 && !writing ? (
        <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>No update yet. Health is whatever the owner said last, so until someone says it, this reads as no update.</p>
      ) : (
        <ol className="space-y-3">
          {updates.map((u) => <UpdateRow key={u._id} update={u} now={now} />)}
        </ol>
      )}
    </Section>
  );
}

function UpdateRow({ update, now }: { update: InitiativeUpdateRow; now: number }) {
  const by = update.by.kind === "role" ? { kind: "role" as const, role_id: update.by.role_id } : update.by;
  return (
    <li className="relative pl-3.5" data-initiative-update={update._id} data-initiative-update-health={update.health}>
      <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full" style={{ background: HEALTH_COLOR[update.health] }} aria-hidden />
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <HealthChip health={update.health} at={update.at} now={now} />
        <OwnerChip owner={by} size={14} />
      </div>
      <MarkdownRenderer content={update.body} className="mt-1 text-[13px] leading-relaxed" />
    </li>
  );
}

/** Update is one control: a short form, a body and a health. The update and
 *  the initiative's health paint in the same tick. */
function UpdateForm({ initiative, onDone }: { initiative: InitiativeRow; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<InitiativeUpdateHealth>(initiative.health === "none" ? "on_track" : initiative.health);
  const post = () => {
    if (!body.trim()) return;
    useInboxStore.getState().postInitiativeUpdate(initiative._id, { client_key: newInitiativeKey(), body: body.trim(), health });
    onDone();
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); post(); }} className="mb-4 rounded-xl border p-2.5" style={{ borderColor: `color-mix(in srgb, ${HEALTH_COLOR[health]} 45%, transparent)` }} data-initiative-update-form>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onDone(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); }}
        rows={3}
        placeholder="How is it going, and what changed since the last update?"
        className="w-full resize-y bg-transparent px-1 py-0.5 text-[13px] leading-relaxed outline-none placeholder:text-sol-text-dim"
        aria-label="Update"
      />
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Health">
          {INITIATIVE_UPDATE_HEALTHS.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={health === h}
              onClick={() => setHealth(h)}
              className={cn("h-7 inline-flex items-center gap-1.5 px-2.5 rounded-md text-[12px] border transition-colors", health !== h && "hover:bg-sol-bg-highlight/60")}
              style={health === h ? { borderColor: HEALTH_COLOR[h], background: `color-mix(in srgb, ${HEALTH_COLOR[h]} 12%, transparent)`, color: "var(--sol-text)" } : { borderColor: "transparent", color: "var(--sol-text-muted)" }}
              data-initiative-update-health-pick={h}
            >
              <span className="w-[7px] h-[7px] rounded-full" style={{ background: HEALTH_COLOR[h] }} aria-hidden />
              {INITIATIVE_HEALTH_LABEL[h]}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" onClick={onDone} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
        <button type="submit" disabled={!body.trim()} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }} data-initiative-update-post>Post update</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------- sub initiatives

function SubInitiatives({ rows, now }: { rows: InitiativeRow[]; now: number }) {
  if (rows.length === 0) return null;
  return (
    <Section name="sub" label="Initiatives under this one" count={rows.length}>
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: HAIRLINE }}>
        {rows.map((r) => (
          <Link key={r._id} href={initiativeHref(r)} className="flex items-center gap-2.5 px-3 py-2.5 border-t first:border-t-0 no-underline transition-colors hover:bg-sol-bg-highlight/50" style={{ borderColor: HAIRLINE }} data-initiative-sub={r.short_id || r._id}>
            <StatusGlyph status={r.status} />
            <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--sol-text)" }}>{r.title}</span>
            <OwnerChip owner={r.owner} size={14} nameless />
            <HealthChip health={r.health} at={r.health_at} now={now} />
          </Link>
        ))}
      </div>
    </Section>
  );
}
