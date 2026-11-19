// Doc-level actions every doc shares: rename, the public share link, archive,
// its project, permanent delete. `cast doc` and the live artifact groups
// (`cast board|sheet|data`, liveArtifactCommand.ts) both call these, so a doc
// and a board change the same way.
import { exitIfPolicyBlocks } from "./config/managedPolicy.js";
import { DEFAULT_WEB_URL } from "./config/readLocalConfig.js";

/** POST to the CLI API; refusals throw (or exit) the way the caller's client does. */
export type DocPost = (path: string, body: Record<string, any>) => Promise<any>;

export async function renameDoc(post: DocPost, id: string, title: string, sessionId?: string | null): Promise<void> {
  const next = title.trim();
  if (!next) throw new Error("give the new title");
  await post("/cli/docs/update", { id, title: next, ...(sessionId ? { session_id: sessionId } : {}) });
}

/** Turn the public link on and answer it: anyone with it can open the doc, signed in or not. */
export async function shareDoc(post: DocPost, id: string): Promise<string> {
  exitIfPolicyBlocks("public_sharing_disabled");
  const result = await post("/cli/docs/share", { id });
  if (result?.error) throw new Error(result.error);
  return `${DEFAULT_WEB_URL.replace(/\/$/, "")}/share/doc/${result.share_token}`;
}

export async function unshareDoc(post: DocPost, id: string): Promise<void> {
  await post("/cli/docs/unshare", { id });
}

/** Archive takes the doc out of every list and makes it read only; unarchive brings it back as it was. */
export async function setDocArchived(post: DocPost, id: string, archived: boolean): Promise<void> {
  await post("/cli/docs/update", { id, archived });
}

/** File the doc under a project in its own workspace, or take it out of one (projectId ""). */
export async function setDocProject(post: DocPost, id: string, projectId: string): Promise<void> {
  await post("/cli/docs/update", { id, project_id: projectId });
}

/** Delete for good, the owner only. A board, sheet or dashboard's elements and history go with it. */
export async function deleteDoc(post: DocPost, id: string): Promise<void> {
  await post("/cli/docs/delete", { id });
}
