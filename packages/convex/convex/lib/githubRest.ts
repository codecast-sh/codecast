// GitHub's REST and GraphQL API as the approval status reads and posts it (changeApprovals.ts, lib/automaticReviewHold.ts),
// with an installation token.

export const GITHUB = "https://api.github.com";

function headers(token: string, accept = "application/vnd.github+json") {
  return { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
}

/** One request: a 404 reads as `{ status: 404 }`, any other failure throws; a raw or diff `accept` answers text, else JSON. */
export async function rest(url: string, token: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<{ status: number; json?: any; text?: string }> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { ...headers(token, init.accept), ...(init.body ? { "Content-Type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 404) return { status: 404 };
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return init.accept?.includes("raw") || init.accept?.includes("diff") ? { status: response.status, text: await response.text() } : { status: response.status, json: await response.json() };
}

export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
