// Project update writes (the project page's Updates tab). The `projectUpdates`
// collection is registered in clientSyncRegistry, which gives it its store
// slot, persistence and pending protection; this slice holds only the
// actions. Each paints the draft so the tab moves in the same tick, and rides
// `dispatch` to the side effect of the same name (convex/dispatch.ts), which
// calls the projectUpdates web mutation.
//
// A post paints a stub keyed by its `client_key`; the server row carrying
// that key supersedes it (altKey). A comment is appended to the post's
// embedded thread, which the next list push replaces whole.
import { action } from "./mutativeMiddleware";

export type ProjectUpdateComment = {
  _id: string;
  author: string;
  author_user_id?: string;
  author_kind: "user" | "agent";
  text: string;
  created_at: number;
};

export type ProjectUpdateRow = {
  _id: string;
  project_id: string;
  client_key?: string;
  short_id?: string;
  author: string;
  author_user_id?: string;
  author_kind: "user" | "agent";
  kind: "update" | "digest";
  title?: string;
  body: string;
  created_at: number;
  updated_at?: number;
  edited_at?: number;
  comments: ProjectUpdateComment[];
};

export type ProjectUpdatesSliceActions = {
  postProjectUpdate: (projectId: string, update: { client_key: string; body: string; title?: string }) => void;
  commentProjectUpdate: (updateId: string, text: string) => void;
  editProjectUpdate: (updateId: string, body: string) => void;
  deleteProjectUpdate: (updateId: string) => void;
};

type ProjectUpdatesDraft = {
  projectUpdates: Record<string, ProjectUpdateRow>;
  currentUser?: { _id: string; name?: string; email?: string } | null;
};

const authorOf = (me: ProjectUpdatesDraft["currentUser"]): string => me?.name || me?.email || "you";

export function newProjectUpdateKey(): string {
  return `pustub-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function createProjectUpdatesSlice(): ProjectUpdatesSliceActions {
  return {
    postProjectUpdate: action(function (this: ProjectUpdatesDraft, projectId: string, update: { client_key: string; body: string; title?: string }) {
      const me = this.currentUser;
      const body = update.body.trim();
      if (!me?._id || !body) return;
      const now = Date.now();
      this.projectUpdates[update.client_key] = {
        _id: update.client_key,
        client_key: update.client_key,
        project_id: projectId,
        author: authorOf(me),
        author_user_id: String(me._id),
        author_kind: "user",
        kind: "update",
        ...(update.title?.trim() ? { title: update.title.trim() } : {}),
        body,
        created_at: now,
        updated_at: now,
        comments: [],
      };
    }),

    commentProjectUpdate: action(function (this: ProjectUpdatesDraft, updateId: string, text: string) {
      const row = this.projectUpdates[updateId];
      const me = this.currentUser;
      const trimmed = text.trim();
      if (!row || !me?._id || !trimmed) return;
      row.comments = [
        ...(row.comments ?? []),
        { _id: newProjectUpdateKey(), author: authorOf(me), author_user_id: String(me._id), author_kind: "user", text: trimmed, created_at: Date.now() },
      ];
    }),

    editProjectUpdate: action(function (this: ProjectUpdatesDraft, updateId: string, body: string) {
      const row = this.projectUpdates[updateId];
      const next = body.trim();
      if (!row || !next || next === row.body) return;
      row.body = next;
      row.edited_at = Date.now();
    }),

    deleteProjectUpdate: action(function (this: ProjectUpdatesDraft, updateId: string) {
      if (this.projectUpdates[updateId]) delete this.projectUpdates[updateId];
    }),
  };
}
