"use client";
// Where a task's reference opens. Everywhere it is the task's page; a surface
// that has a page of its own for some tasks provides that place here, so
// every ct-N link inside it, including the ones a shared component draws (a
// decision's meta, an entity pill), stays inside it. /line provides one that
// opens a problem on its problem page (line-journeys.md LJ5).
import { createContext, useCallback, useContext, type ReactNode } from "react";

/** A task ref (ct-N) to the place it opens here, or null where the surface has no page of its own for it. */
type TaskPlace = (ref: string) => string | null;

const TaskHrefContext = createContext<TaskPlace | null>(null);

export function TaskHrefProvider({ place, children }: { place: TaskPlace; children: ReactNode }) {
  return <TaskHrefContext.Provider value={place}>{children}</TaskHrefContext.Provider>;
}

/** Where a task's reference opens on this surface: its place here, else `/tasks/<ref>`. */
export function useTaskHref(): (ref: string) => string {
  const place = useContext(TaskHrefContext);
  return useCallback((ref: string) => place?.(ref) ?? `/tasks/${ref}`, [place]);
}

/** The surface's own place for a task, or null when it has none (the caller keeps its own href). */
export function useTaskPlace(): TaskPlace | null {
  return useContext(TaskHrefContext);
}
