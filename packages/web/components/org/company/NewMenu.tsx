"use client";
// The Org screen's one place to create (cohesive build spec D9): New ▸ Goal,
// Project or Role. A goal is written at once, as a stub the server row
// supersedes by its key, and its sheet opens with the name ready to type. A
// project is named first, then written the same way: a stub under its key
// that the synced row supersedes (the projects altKey), its sheet open at
// once. Nothing waits on the server. A role opens the hire dialog.
import { useRef, useState } from "react";
import { ChevronDown, Flag, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../../store/inboxStore";
import { useWorkspaceArgs, workspaceStamp } from "../../../hooks/useWorkspaceArgs";
import { newInitiativeKey } from "../../../lib/initiatives";
import { cn } from "../../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "../../ui/popover";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import type { OrgObjectKind } from "@codecast/shared/entities";

const CONTROL = "h-[28px] inline-flex items-center gap-1.5 px-2.5 rounded-md border text-[12px] transition-colors";

/** A goal's name before the person types one. */
const NEW_GOAL_TITLE = "Untitled goal";

export function NewMenu({ onCreated, onRole, canRole }: {
  /** Open the new object's sheet; `focus` asks for its name to be typed. */
  onCreated: (kind: OrgObjectKind, ref: string, focus: boolean) => void;
  onRole: () => void;
  /** Hiring is the agents half: off where the person may not hire or the org feature is off. */
  canRole: boolean;
}) {
  const workspace = useWorkspaceArgs();
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // An item that hands focus on (the new goal's name, the project's name, the
  // hire dialog) keeps the closing menu from pulling it back to New; a menu
  // closed without a pick returns focus there as usual.
  const handedOn = useRef(false);
  const pick = (fn: () => void) => () => { handedOn.current = true; fn(); };
  useWatchEffect(() => { if (naming) requestAnimationFrame(() => input.current?.focus()); }, [naming]);

  const newGoal = () => {
    const st = useInboxStore.getState();
    const me = st.currentUser?._id ? String(st.currentUser._id) : null;
    if (!me || workspace === "skip") return;
    const client_key = newInitiativeKey();
    st.createInitiative({ client_key, title: NEW_GOAL_TITLE, owner: { kind: "user", user_id: me }, ...(workspaceStamp(workspace) as { workspace: "personal" | "team"; team_id?: string }) });
    onCreated("initiative", client_key, true);
  };

  const createProject = () => {
    const name = title.trim();
    if (!name || workspace === "skip") return;
    const client_key = `projstub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // The stub paints in this tick and its sheet opens on it; a refusal takes the stub back out and says why.
    useInboxStore.getState()
      .createProject({ title: name, client_key, ...workspaceStamp(workspace) })
      .catch((e: any) => toast.error(e?.message?.split("\n")[0] || "Could not create the project"));
    setNaming(false);
    setTitle("");
    onCreated("project", client_key, false);
  };

  return (
    <Popover open={naming} onOpenChange={setNaming}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(CONTROL, "hover:bg-sol-bg-highlight/60")} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-secondary)" }} data-org-new>
              New <ChevronDown className="h-3 w-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent align="end" className="min-w-[170px]" onCloseAutoFocus={(e) => { if (!handedOn.current) return; handedOn.current = false; e.preventDefault(); }}>
          <DropdownMenuItem onSelect={pick(newGoal)} data-org-new-goal><Flag className="h-3.5 w-3.5 opacity-70" /> Goal</DropdownMenuItem>
          <DropdownMenuItem onSelect={pick(() => setNaming(true))} data-org-new-project><span aria-hidden className="mx-[3px] h-2 w-2 rotate-45 rounded-[2px]" style={{ background: "var(--sol-text-muted)" }} /> Project</DropdownMenuItem>
          {canRole && <DropdownMenuItem onSelect={pick(onRole)} data-org-new-role><UserPlus className="h-3.5 w-3.5 opacity-70" /> Role</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent align="end" className="w-[300px] p-2.5" data-org-new-project-form>
        <form onSubmit={(e) => { e.preventDefault(); createProject(); }} className="flex items-center gap-2">
          <input
            ref={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Name the project"
            aria-label="Project name"
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 h-8 text-[12.5px] outline-none focus:border-[color-mix(in_srgb,var(--sol-cyan)_55%,var(--sol-border))]"
            style={{ borderColor: "var(--sol-border)", color: "var(--sol-text)" }}
          />
          <button type="submit" disabled={!title.trim()} className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-text)", color: "var(--sol-bg)" }}>
            Create
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
