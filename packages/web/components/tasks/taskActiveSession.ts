import { createContext, useContext } from "react";
import { useInboxStore } from "../../store/inboxStore";

/**
 * Which session is working each task, when a surface supplies it instead of
 * the store. The marketing hero (app/(marketing)/heroFly/sandbox.tsx) renders
 * fixture tasks, and a visitor's own store must not decide whether one of them
 * pulses as live. Null, the default, reads the store.
 */
export const TaskActiveSessionsOverride = createContext<Record<string, any> | null>(null);

/** The live session working a task, or null: the one read the task row and its session badge share. */
export function useTaskActiveSession(taskId: string): any | null {
  const override = useContext(TaskActiveSessionsOverride);
  const stored = useInboxStore((s) => (override ? undefined : s.taskActiveSessions[taskId]));
  return (override ? override[taskId] : stored) ?? null;
}
