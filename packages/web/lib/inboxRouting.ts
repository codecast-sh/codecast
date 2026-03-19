export function isInboxRoute(pathname?: string | null): boolean {
  return pathname === "/inbox" || pathname?.startsWith("/inbox/") || false;
}

export function isInboxSessionView(pathname?: string | null, source?: string | null): boolean {
  return isInboxRoute(pathname) || ((pathname?.startsWith("/conversation/") ?? false) && source === "inbox");
}
