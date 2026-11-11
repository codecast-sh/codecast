import { ChevronDown, FolderGit2, X } from "lucide-react";
import { getLabelColor } from "../../lib/labelColors";
import { SegmentedToggle } from "../SegmentedToggle";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { modernFocusRing } from "../ui/styles";
import { Face } from "./ActivityParts";
import { togglePerson, type ActivityView } from "./activityView";
import type { PersonFacet } from "./activityModel";

// The Activity page's filters, in the header's second row: whose work (Team
// or Mine), the people as faces you press, the project, what waits on
// someone, and at the far right how the days group. Each one is the address
// (useActivityView), so a filtered view can be sent. Classic and Minimal draw
// the buttons 28px tall, level with the faces and the toggles beside them
// (Button's Classic sm is 32px); Modern's controls are its `modern:` ones.

/** The filter row's buttons: 28px in Classic and Minimal, Modern's sm there. */
const ROW_BUTTON = "h-7 modern:h-control-sm";

const FACES_SHOWN = 8;

const SCOPES = [
  { key: "team", label: "Team" },
  { key: "my", label: "Mine" },
];
const GROUPINGS = [
  { key: "person", label: "People" },
  { key: "project", label: "Projects" },
];

export function ActivityScopeToggle({ view, set }: { view: ActivityView; set: (patch: Partial<ActivityView>) => void }) {
  return <SegmentedToggle size="sm" value={view.scope} onChange={(k) => set({ scope: k as ActivityView["scope"], people: [] })} items={SCOPES} />;
}

export function ActivityFilterRow({ view, set, hasTeam, faces, projects, needsCount }: {
  view: ActivityView;
  set: (patch: Partial<ActivityView>) => void;
  hasTeam: boolean;
  faces: PersonFacet[];
  projects: Array<{ name: string; sessions: number }>;
  needsCount: number;
}) {
  const filtered = view.people.length > 0 || !!view.project || view.needs || !!view.dir;
  return (
    <div data-activity-filters className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      {hasTeam && <ActivityScopeToggle view={view} set={set} />}
      {view.scope === "team" && faces.length > 1 && (
        <PeopleFaces faces={faces} selected={view.people} onToggle={(id) => set({ people: togglePerson(view.people, id) })} />
      )}
      {projects.length > 0 && <ProjectMenu projects={projects} value={view.project} onChange={(project) => set({ project })} />}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={view.needs}
        data-activity-needs-toggle
        onClick={() => set({ needs: !view.needs })}
        className={`${ROW_BUTTON} ${view.needs ? "border-sol-yellow/50 bg-sol-yellow/10 text-sol-text modern:border-sol-yellow/50 modern:bg-sol-yellow/10 modern:text-sol-text" : "text-sol-text-muted modern:text-sol-text-muted"}`}
      >
        <SessionStatusMark status="needs_you" />
        Needs someone
        <span className={`tabular-nums ${needsCount > 0 ? "text-sol-yellow" : "text-sol-text-dim"}`}>{needsCount}</span>
      </Button>
      {view.dir && (
        <Button type="button" variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => set({ dir: null })} title={view.dir} aria-label={`Show every workspace, not only ${view.dir}`}>
          <FolderGit2 aria-hidden />
          <span className="font-mono">{view.dir.split("/").filter(Boolean).pop()}</span>
          <X aria-hidden />
        </Button>
      )}
      {filtered && (
        <Button type="button" variant="ghost" size="sm" className={`${ROW_BUTTON} text-sol-text-muted modern:text-sol-text-muted`} onClick={() => set({ people: [], project: null, needs: false, dir: null })}>
          Clear
        </Button>
      )}
      <span className="ml-auto">
        <SegmentedToggle variant="bare" size="sm" value={view.group} onChange={(k) => set({ group: k as ActivityView["group"] })} items={GROUPINGS} />
      </span>
    </div>
  );
}

/** Everyone in the feed as a face: press one to see only theirs, more to add
 *  them. Working now wears a green dot; the rest of the team folds into +N. */
function PeopleFaces({ faces, selected, onToggle }: { faces: PersonFacet[]; selected: string[]; onToggle: (id: string) => void }) {
  // A chosen face never folds away, wherever it ranks.
  const chosen = faces.filter((f) => selected.includes(f.actor.id));
  const rest = faces.filter((f) => !selected.includes(f.actor.id));
  const room = Math.max(0, FACES_SHOWN - chosen.length);
  const shown = [...chosen, ...rest.slice(0, room)].sort((a, b) => faces.indexOf(a) - faces.indexOf(b));
  const hidden = rest.slice(room);
  const any = selected.length > 0;
  return (
    <div role="group" aria-label="People" className="flex items-center gap-0.5">
      {shown.map((f) => {
        const on = selected.includes(f.actor.id);
        return (
          <button
            key={f.actor.id}
            type="button"
            aria-pressed={on}
            aria-label={f.actor.name}
            title={`${f.actor.name} · ${f.sessions} session${f.sessions === 1 ? "" : "s"}${f.live ? ` · ${f.live} live` : ""}`}
            data-activity-face={f.actor.id}
            onClick={() => onToggle(f.actor.id)}
            className={`relative flex size-7 items-center justify-center rounded-full transition-opacity modern:duration-press ${modernFocusRing} ${on ? "ring-2 ring-sol-cyan" : any ? "opacity-45 hover:opacity-100" : "hover:opacity-80"}`}
          >
            <Face actor={f.actor} size={24} />
            {f.live > 0 && <span aria-hidden className="absolute bottom-0 right-0 size-2 rounded-full bg-sol-green ring-2 ring-sol-bg" />}
          </button>
        );
      })}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger className={`flex h-7 items-center rounded-md px-1.5 text-meta tabular-nums text-sol-text-muted hover:bg-sol-text/[0.06] hover:text-sol-text modern:rounded-control ${modernFocusRing}`}>
            +{hidden.length}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80">
            {hidden.map((f) => (
              <DropdownMenuCheckboxItem key={f.actor.id} checked={false} onCheckedChange={() => onToggle(f.actor.id)} className="gap-2">
                <Face actor={f.actor} size={18} />
                <span className="min-w-0 flex-1 truncate">{f.actor.name}</span>
                <span className="text-meta tabular-nums text-sol-text-dim">{f.sessions}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ProjectMenu({ projects, value, onChange }: { projects: Array<{ name: string; sessions: number }>; value: string | null; onChange: (project: string | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-activity-project-menu className={`${ROW_BUTTON} ${value ? "" : "text-sol-text-muted modern:text-sol-text-muted"}`}>
          {value ? <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${getLabelColor(value).dot}`} /> : <FolderGit2 aria-hidden />}
          <span className={value ? "max-w-[12rem] truncate font-mono" : ""}>{value ?? "All projects"}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80">
        <DropdownMenuItem onSelect={() => onChange(null)}>All projects</DropdownMenuItem>
        <DropdownMenuSeparator />
        {projects.map((p) => (
          <DropdownMenuItem key={p.name} onSelect={() => onChange(p.name === value ? null : p.name)} className="gap-2">
            <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${getLabelColor(p.name).dot}`} />
            <span className={`min-w-0 flex-1 truncate font-mono ${p.name === value ? "text-sol-cyan" : ""}`}>{p.name}</span>
            <span className="text-meta tabular-nums text-sol-text-dim">{p.sessions}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
