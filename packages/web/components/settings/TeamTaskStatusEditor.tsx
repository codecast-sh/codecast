"use client";
/**
 * Per-team task status editor (Linear-style). Statuses live grouped under the
 * six fixed categories; a team renames, recolors, reorders, adds and removes
 * them here. The whole list saves wholesale through teams.updateTaskStatuses —
 * it is tiny, edited rarely, and the shared normalizer
 * (@codecast/shared/tasks normalizeTeamTaskStatuses) is the one validation
 * authority for both this form and the mutation.
 *
 * Renaming a default keeps its id (= the category name), so every existing
 * task re-labels instantly with zero task writes.
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
  normalizeTeamTaskStatuses,
  teamTaskStatuses,
  type TaskStatusCategory,
  type TeamTaskStatus,
} from "@codecast/shared/tasks";
import { TASK_STATUS, TASK_STATUS_ORDER } from "../TaskStatusBadge";
import { STATUS_COLOR_CLASSES, statusVisual } from "../../lib/taskStatuses";

const mintId = () => `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
  const [draft, setDraft] = useState<TeamTaskStatus[] | null>(null);
  const [saving, setSaving] = useState(false);
  const statuses = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const edit = (fn: (list: TeamTaskStatus[]) => TeamTaskStatus[]) =>
    setDraft((cur) => fn(cur ?? saved));

  const rename = (id: string, name: string) =>
    edit((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
  const recolor = (id: string, color?: string) =>
    edit((list) => list.map((s) => (s.id === id ? { ...s, color: color as any } : s)));
  const remove = (id: string) => edit((list) => list.filter((s) => s.id !== id));
  const add = (category: TaskStatusCategory) =>
    edit((list) => [...list, { id: mintId(), name: "", category }]);
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
      toast.success("Task statuses saved");
    } catch (err: any) {
      toast.error(err?.message?.split("\n")[0] || "Could not save statuses");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6 bg-sol-bg border-sol-border">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="text-base font-semibold text-sol-text">Task statuses</h2>
          <p className="text-xs text-sol-text-muted mt-0.5">
            Rename, recolor and add statuses within each category — like Linear.
            Boards, groups and pickers across the team use this vocabulary.
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-4">
        {TASK_STATUS_ORDER.map((category) => {
          const CatIcon = TASK_STATUS[category].icon;
          const rows = statuses.filter((s) => s.category === category);
          return (
            <div key={category}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <CatIcon className={`w-3.5 h-3.5 ${TASK_STATUS[category].color}`} />
                <span className="text-[11px] uppercase tracking-widest text-sol-text-dim font-medium">
                  {DEFAULT_TASK_STATUS_NAMES[category]}
                </span>
                {isAdmin && (
                  <button
                    onClick={() => add(category)}
                    title={`Add a status under ${DEFAULT_TASK_STATUS_NAMES[category]}`}
                    className="ml-1 w-5 h-5 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim/60 hover:text-sol-text-dim transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {rows.map((s, i) => {
                  const v = statusVisual(s);
                  const Icon = v.icon;
                  return (
                    <div key={s.id} className="flex items-center gap-2 rounded-md border border-sol-border/40 bg-sol-bg-alt/30 px-2 py-1.5">
                      <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${v.color}`} />
                      {isAdmin ? (
                        <input
                          value={s.name}
                          placeholder="Status name"
                          onChange={(e) => rename(s.id, e.target.value)}
                          className="flex-1 min-w-0 bg-transparent text-sm text-sol-text outline-none placeholder:text-sol-text-dim/50"
                        />
                      ) : (
                        <span className="flex-1 min-w-0 text-sm text-sol-text truncate">{s.name}</span>
                      )}
                      {isAdmin && (
                        <>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {TASK_STATUS_COLORS.map((c) => (
                              <button
                                key={c}
                                title={c}
                                onClick={() => recolor(s.id, s.color === c ? undefined : c)}
                                className={`w-3.5 h-3.5 rounded-full border transition-transform hover:scale-125 ${
                                  STATUS_COLOR_CLASSES[c].bg
                                } ${STATUS_COLOR_CLASSES[c].border} ${
                                  s.color === c ? "ring-1 ring-sol-text scale-110" : ""
                                }`}
                              >
                                <span className={`block w-1.5 h-1.5 m-auto rounded-full ${STATUS_COLOR_CLASSES[c].color.replace("text-", "bg-")}`} />
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center flex-shrink-0">
                            <button
                              onClick={() => move(s.id, -1)}
                              disabled={i === 0}
                              className="w-5 h-5 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim/60 hover:text-sol-text-dim disabled:opacity-20 transition-colors"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => move(s.id, 1)}
                              disabled={i === rows.length - 1}
                              className="w-5 h-5 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim/60 hover:text-sol-text-dim disabled:opacity-20 transition-colors"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => remove(s.id)}
                              disabled={rows.length === 1}
                              title={rows.length === 1 ? "Each category keeps at least one status" : "Delete status"}
                              className="w-5 h-5 flex items-center justify-center rounded hover:bg-sol-red/10 text-sol-text-dim/60 hover:text-sol-red disabled:opacity-20 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </>
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
    </Card>
  );
}
