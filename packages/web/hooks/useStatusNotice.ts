import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import type { LucideIcon } from "lucide-react";

/**
 * Transient status notices — offline, storage degraded, CLI offline, tmux
 * missing — get one dedicated surface: StatusNoticeStack, a card stack fixed
 * to the bottom-left corner, so a status that comes and goes never pushes
 * the layout down or covers the working area. Owners describe the notice;
 * the stack owns the look.
 */
export type StatusNotice = {
  tone: "yellow" | "orange" | "red";
  icon: LucideIcon;
  title: string;
  detail?: ReactNode;
  /** An inline control such as a copy-the-command button. */
  action?: ReactNode;
  onDismiss?: () => void;
};

type NoticeStore = {
  notices: Map<string, StatusNotice>;
  set: (id: string, notice: StatusNotice | null) => void;
};

export const useStatusNoticeStore = create<NoticeStore>((set) => ({
  notices: new Map(),
  set: (id, notice) =>
    set((s) => {
      if (!notice && !s.notices.has(id)) return s;
      const next = new Map(s.notices);
      if (notice) next.set(id, notice);
      else next.delete(id);
      return { notices: next };
    }),
}));

/**
 * Publish a notice while `notice` is non-null; withdraw it when it turns
 * null or the owner unmounts. Call unconditionally — pass null to stay quiet.
 */
export function useStatusNotice(id: string, notice: StatusNotice | null) {
  const set = useStatusNoticeStore((s) => s.set);
  useEffect(() => {
    set(id, notice);
  }, [id, notice, set]);
  useEffect(() => () => set(id, null), [id, set]);
}
