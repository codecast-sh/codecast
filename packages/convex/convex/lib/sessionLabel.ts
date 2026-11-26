// How a notification names a session. A notification's text is written once,
// and goes out as a push, so it can reach a lock screen: a session too young
// to have a generated title is named by its project folder, never by a bare
// short id and never by the person's raw opening words. A leaf module.

type SessionRow = {
  title?: string | null;
  project_path?: string | null;
} | null | undefined;

export function sessionLabel(conv: SessionRow, fallback = "Session"): string {
  const title = conv?.title?.trim();
  if (title) return title;
  return conv?.project_path?.split("/").filter(Boolean).pop() || fallback;
}
