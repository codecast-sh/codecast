// Claude Code's browser sign-ins (`claude auth login`, `claude setup-token`)
// can finish on a device other than the machine running them. The CLI hands
// $BROWSER a URL whose redirect is the machine's own localhost listener, which
// a phone cannot reach; it also prints a second URL with the same PKCE
// challenge and state whose redirect is Anthropic's code page, and waits for
// the code that page shows ("Paste code here if prompted >"). These helpers
// turn the first URL into the second, and check a pasted code before it is
// typed into the waiting CLI. The code alone is worthless: exchanging it needs
// the PKCE verifier, which never leaves the CLI process.

/** The code page Claude Code's printed sign-in URL redirects to (2.1.289). */
export const OAUTH_CODE_PASTE_REDIRECT = "https://platform.claude.com/oauth/code/callback";

/**
 * The sign-in URL that ends on Anthropic's code page, for finishing on another
 * device. Built from the $BROWSER URL, taking the code-page redirect from the
 * CLI's own printout when the pane shows one (so a moved callback follows the
 * CLI), else the known one. Null when the input is not an OAuth URL.
 */
export function codePasteSignInUrl(browserUrl: string, pane = ""): string | null {
  let url: URL;
  try {
    url = new URL(browserUrl.trim());
  } catch {
    return null;
  }
  if (!url.searchParams.has("redirect_uri")) return null;
  const printed = pane.match(/redirect_uri=(https%3A%2F%2F[^&\s]+)/i)?.[1];
  let redirect = OAUTH_CODE_PASTE_REDIRECT;
  if (printed) {
    try {
      redirect = decodeURIComponent(printed);
    } catch {}
  }
  url.searchParams.set("redirect_uri", redirect);
  return url.toString();
}

/** The approval code as Anthropic's code page shows it (`code#state`), trimmed; throws on anything else. */
export function oauthApprovalCode(value: string): string {
  const code = value.trim();
  if (!/^[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?$/.test(code) || code.length > 4096) {
    throw new Error("Paste the approval code shown by Claude, without any extra text.");
  }
  return code;
}

/**
 * A device-code sign-in's prompt (`codex login --device-auth`): the page to
 * open on any device and the one-time code to enter there, read off the CLI's
 * printout. Null until both have appeared.
 */
export function deviceCodePrompt(pane: string): { url: string; code: string } | null {
  const text = pane.replace(/\x1b\[[0-9;]*m/g, "");
  const url = text.match(/https:\/\/\S+/)?.[0];
  const code = text.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)?.[0];
  return url && code ? { url, code } : null;
}
