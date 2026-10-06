// `cast auth` signs a terminal in from this browser tab, then keeps the person
// in the terminal for its setup questions; the daemon (and so the first
// synced session) starts only after them. The tab stamps the moment so the
// inbox it hands off to can say "connected, sessions on the way" instead of
// asking someone who just installed the CLI to install it.

export const CLI_CONNECTED_KEY = "codecast-cli-connected";
export const CLI_CONNECTED_TTL_MS = 30 * 60 * 1000;

export function markCliConnected(now = Date.now()): void {
  try {
    sessionStorage.setItem(CLI_CONNECTED_KEY, String(now));
  } catch {
    // Private mode can throw; the inbox then shows its install card, as before.
  }
}

export function cliJustConnected(
  now = Date.now(),
  store: Pick<Storage, "getItem"> | null = "sessionStorage" in globalThis ? sessionStorage : null,
): boolean {
  try {
    const at = Number(store?.getItem(CLI_CONNECTED_KEY));
    return !!at && now - at < CLI_CONNECTED_TTL_MS;
  } catch {
    return false;
  }
}
