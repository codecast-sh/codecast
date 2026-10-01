// The Slack Web API: one POST per method, never throwing. A network failure
// comes back as { ok: false, error: "network: …" } like any Slack error.
export type SlackResp = { ok: boolean; error?: string; [k: string]: any };

// JSON only for the write methods that accept it (`blocks` needs it); form
// encoding for everything else, including chat.getPermalink, which is a read
// and rejects a JSON body.
const JSON_METHODS = new Set([
  "chat.postMessage", "chat.update", "chat.delete", "reactions.add", "reactions.remove",
]);

export async function slackApi(token: string, method: string, params: Record<string, unknown> = {}): Promise<SlackResp> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string;
  if (JSON_METHODS.has(method)) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(params);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const [k, val] of Object.entries(params)) {
      if (val === undefined || val === null) continue;
      form.set(k, typeof val === "string" ? val : JSON.stringify(val));
    }
    body = form.toString();
  }
  try {
    const resp = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers, body });
    return (await resp.json()) as SlackResp;
  } catch (error) {
    return { ok: false, error: `network: ${error instanceof Error ? error.message : String(error)}` };
  }
}
