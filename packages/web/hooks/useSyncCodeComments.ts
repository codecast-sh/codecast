// Code comments (review_comments) — store-fed, one feeder per PR.
//
// A comment is anchored to a file and line, or to the PR itself. Both shapes
// arrive in one payload and land in the `codeComments` store key; the page
// reads the store and never the query (the registered-feeds guard enforces
// that).
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import type { CodeCommentRow } from "../lib/prView";

// `api` is a proxy, so naming a function prod has not deployed yet still
// produces a reference; the call then fails and useQueryNoThrow (inside
// useSyncCollection) reports it as an error instead of unmounting the surface.
const api = _api as any;

const KEY = "codeComments";

export function useSyncPRCodeComments(prId: string | undefined) {
  return useSyncCollection(KEY, api.codeComments.listForPR, prId ? { pull_request_id: prId } : "skip");
}

const codeCommentSig = (c: CodeCommentRow) =>
  `${c.content}|${c.resolved ?? ""}|${c.resolved_at ?? ""}|${c.line_number ?? ""}|${c.file_path ?? ""}`;

const byCreatedAsc = (a: CodeCommentRow, b: CodeCommentRow) => a.created_at - b.created_at;

export function useCodeComments(where?: (row: CodeCommentRow) => boolean): CodeCommentRow[] {
  return useCollectionRows<CodeCommentRow>(KEY, { where, sig: codeCommentSig, sort: byCreatedAsc });
}
