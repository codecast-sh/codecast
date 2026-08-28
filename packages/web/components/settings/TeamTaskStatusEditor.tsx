"use client";
/**
 * Per-team task status editor, laid out like Linear's workflow settings: one
 * tinted band per category with a "+" to add a status under it, and each
 * status as a tall row — a tinted tile holding the status circle, the name,
 * and a muted second line (task count, "Default" for the category's default).
 * Clicking a row opens it for editing in place: rename, recolor, move within
 * its category, delete.
 *
 * The whole list saves wholesale through teams.updateTaskStatuses — it is
 * tiny, edited rarely, and the shared normalizer
 * (@codecast/shared/tasks normalizeTeamTaskStatuses) is the one validation
 * authority for both this form and the mutation. Renaming a default keeps
 * its id (= the category name), so every existing task re-labels instantly
 * with zero task writes.
 */
import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import {
  DEFAULT_TASK_STATUS_NAMES,
  TASK_STATUS_COLORS,
  isActiveTask,
  normalizeTeamTaskStatuses,
  teamTaskStatuses,
  type TaskStatusCategory,
  type TeamTaskStatus,
} from "@codecast/shared/tasks";
import { TASK_STATUS_ORDER } from "../TaskStatusBadge";
import { STATUS_COLOR_CLASSES, statusVisual, taskStatusKey } from "../../lib/taskStatuses";
import { useInboxStore } from "../../store/inboxStore";
import { filterToWorkspace } from "../../lib/workspaceScope";

const mintId = () => `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Unsaved drafts survive the editor unmounting (modal close, section switch,
// backdrop click) so a half-finished edit is recoverable instead of silently
// discarded. Keyed by team; cleared on save or explicit discard.
const pendingDrafts = new Map<string, TeamTaskStatus[]>();

// Linear names the categories by workflow phase; ours map onto them.
const CATEGORY_LABEL: Record<TaskStatusCategory, string> = {
  backlog: "Backlog",
  open: "Unstarted",
  in_progress: "Started",
  in_review: "In review",
  done: "Completed",
  dropped: "Canceled",
};

export function TeamTaskStatusEditor({
  teamId,
  configured,
  isAdmin,
}: {
  teamId: Id<"teams">;
  /** teams.task_statuses as stored (undefined = defaults). */
  configured: TeamTaskStatus[] | undefined;
  isAdmin: boolean;
}) {
  const updateTaskStatuses = useMutation(api.teams.updateTaskStatuses);
  const saved = useMemo(() => teamTaskStatuses(configured), [configured]);
  const draftKey = String(teamId);
  const [draft, setDraftState] = useState<TeamTaskStatus[] | null>(
    () => pendingDrafts.get(draftKey) ?? null,
  );
  const setDraft = (
    updater: TeamTaskStatus[] | null | ((cur: TeamTaskStatus[] | null) => TeamTaskStatus[] | null),
  ) =>
    setDraftState((cur) => {
      const next = typeof updater === "function" ? updater(cur) : updater;
      if (next === null) pendingDrafts.delete(draftKey);
      else pendingDrafts.set(draftKey, next);
      return next;
    });
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const statuses = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  // Live task counts per status, from this team's active tasks. Counted
  // against the SAVED list (what tasks currently resolve to), so a renamed
  // draft row keeps its count and a brand-new row honestly reads 0.
  const tasks = useInboxStore((s) => s.tasks);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of filterToWorkspace(Object.values(tasks) as any[], String(teamId))) {
      if (!isActiveTask(t)) continue;
      const key = taskStatusKey(t, saved);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  }, [tasks, teamId, saved]);

  const edit = (fn: (list: TeamTaskStatus[]) => TeamTaskStatus[]) =>
    setDraft((cur) => fn(cur ?? saved));

  const rename = (id: string, name: string) =>
    edit((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
  const recolor = (id: string, color?: string) =>
    edit((list) => list.map((s) => (s.id === id ? { ...s, color: color as any } : s)));
  const remove = (id: string) => {
    edit((list) => list.filter((s) => s.id !== id));
    setOpenId(null);
  };
  const add = (category: TaskStatusCategory) => {
    const id = mintId();
    edit((list) => [...list, { id, name: "", category }]);
    setOpenId(id);
  };
  // Swap with the neighboring status OF THE SAME CATEGORY (the board orders by
  // category first, so cross-category positions in the flat array are inert).
  const move = (id: string, dir: -1 | 1) =>
    edit((list) => {
      const idx = list.findIndex((s) => s.id === id);
      if (idx < 0) return list;
      const cat = list[idx].category;
      let j = idx + dir;
      while (j >= 0 && j < list.length && list[j].category !== cat) j += dir;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const save = async () => {
    if (!draft) return;
    let normalized: TeamTaskStatus[];
    try {
      normalized = normalizeTeamTaskStatuses(draft);
    } catch (err: any) {
      toast.error(err?.message || "Invalid status list");
      return;
    }
    setSaving(true);
    try {
      await updateTaskStatuses({ team_id: teamId, statuses: normalized });
      setDraft(null);
      setOpenId(null);
      toast.success("Task statuses saved");
    } catch (err: any) {
      toast.error(err?.message?.split("\n")[0] || "Could not save statuses");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6 bg-sol-bg border-sol-border">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-sol-text">Task statuses</h2>
        <p className="text-xs text-sol-text-muted mt-0.5">
          The team's workflow. Statuses live under fixed categories; boards, groups and pickers use these names.
        </p>
      </div>

      <div className="space-y-2">
        {TASK_STATUS_ORDER.map((category) => {
          const rows = statuses.filter((s) => s.category === category);
          return (
            <div key={category}>
              <div className="flex items-center justify-between rounded-md bg-sol-bg-alt/70 px-3 py-2">
                <span className="text-sm text-sol-text-muted">{CATEGORY_LABEL[category]}</span>
                {isAdmin && (
                  <button
                    onClick={() => add(category)}
                    title={`Add a status under ${CATEGORY_LABEL[category]}`}
                    className="w-6 h-6 flex items-center justify-center rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="divide-y divide-sol-border/30">
                {rows.map((s, i) => {
                  const v = statusVisual(s, statuses);
                  const Icon = v.icon;
                  const isDefault = s.id === category;
                  const count = counts.get(s.id) ?? 0;
                  const open = openId === s.id;
                  const canOpen = isAdmin;
                  return (
                    <div key={s.id} className="px-1">
                      <div
                        role={canOpen ? "button" : undefined}
                        tabIndex={canOpen ? 0 : undefined}
                        onClick={() => canOpen && setOpenId(open ? null : s.id)}
                        onKeyDown={(e) => { if (canOpen && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpenId(open ? null : s.id); } }}
                        className={`flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors ${
                          canOpen ? "cursor-pointer hover:bg-sol-bg-alt/40" : ""
                        } ${open ? "bg-sol-bg-alt/40" : ""}`}
                      >
                        <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${v.bg}`}>
                          <Icon className={`w-4 h-4 ${v.color}`} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-sm text-sol-text">
                            <span className="truncate">{s.name || <span className="text-sol-text-dim italic">Unnamed</span>}</span>
                            {isDefault && <span className="text-sol-text-dim">· Default</span>}
                          </span>
                          <span className="block text-xs text-sol-text-muted mt-0.5">
                            {count === 1 ? "1 task" : `${count} tasks`}
                          </span>
                        </span>
                      </div>

                      {open && (
                        <div className="ml-14 mr-2 mb-3 mt-1 flex flex-wrap items-center gap-x-4 gap-y-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            autoFocus
                            value={s.name}
                            placeholder="Status name"
                            onChange={(e) => rename(s.id, e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") setOpenId(null); }}
                            className="min-w-[10rem] flex-1 rounded-md border border-sol-border bg-sol-bg px-2 py-1 text-sm text-sol-text outline-none focus:border-sol-cyan/60 placeholder:text-sol-text-dim/50"
                          />
                          <div className="flex items-center gap-1.5">
                            {TASK_STATUS_COLORS.map((c) => (
                              <button
                                key={c}
                                title={c}
                                onClick={() => recolor(s.id, s.color === c ? undefined : c)}
                                className={`w-4 h-4 rounded-full border transition-transform hover:scale-125 ${
                                  STATUS_COLOR_CLASSES[c].bg
                                } ${STATUS_COLOR_CLASSES[c].border} ${
                                  s.color === c ? "ring-2 ring-sol-text/60 ring-offset-1 ring-offset-sol-bg" : ""
                                }`}
                              >
                                <span className={`block w-2 h-2 m-auto rounded-full ${STATUS_COLOR_CLASSES[c].color.replace("text-", "bg-")}`} />
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => move(s.id, -1)}
                              disabled={i === 0}
                              title="Move up"
                              className="w-6 h-6 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text disabled:opacity-20 transition-colors"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => move(s.id, 1)}
                              disabled={i === rows.length - 1}
                              title="Move down"
                              className="w-6 h-6 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text disabled:opacity-20 transition-colors"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => remove(s.id)}
                              disabled={rows.length === 1}
                              title={rows.length === 1 ? "Each category keeps at least one status" : "Delete status"}
                              className="w-6 h-6 flex items-center justify-center rounded hover:bg-sol-red/10 text-sol-text-dim hover:text-sol-red disabled:opacity-20 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {!isAdmin && (
        <p className="text-[11px] text-sol-text-dim mt-3">Only team admins can edit statuses.</p>
      )}
      {isAdmin && dirty && (
        // Sticky pins to the scroller's content box, so -bottom-5 cancels the
        // settings panel's py-5 and the bar sits on the visible edge.
        <div className="sticky -bottom-5 -mx-6 -mb-6 mt-4 flex items-center justify-between gap-3 rounded-b-xl border-t border-sol-border bg-sol-bg px-6 py-3">
          <span className="flex items-center gap-2 text-xs text-sol-yellow">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow" />
            Unsaved changes
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setOpenId(null); }} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
