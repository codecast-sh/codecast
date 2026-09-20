import type http from "http";
import { authorizeLocalRequest, corsHeaders, type TerminalServerOptions } from "./terminal/terminalServer.js";

export const DESKTOP_ALERT_LEASE_MS = 15_000;
const MAX_ENTRIES = 2_000;

export class NotificationClaims {
  private desktops = new Map<string, number>();
  private events = new Map<string, number>();

  constructor(private now = Date.now) {}

  desktop(scope: string, client: string, active: boolean) {
    this.prune();
    const key = JSON.stringify([scope, client]);
    if (active) this.desktops.set(key, this.now() + DESKTOP_ALERT_LEASE_MS);
    else this.desktops.delete(key);
    this.trim(this.desktops);
  }

  claim(scope: string, event: string, desktop: boolean, ttl: number, preferDesktop = true): "claimed" | "duplicate" | "desktop" {
    this.prune();
    const key = JSON.stringify([scope, event]);
    if (this.events.has(key)) return "duplicate";
    if (!desktop && preferDesktop && [...this.desktops.keys()].some((k) => JSON.parse(k)[0] === scope)) return "desktop";
    this.events.set(key, this.now() + ttl);
    this.trim(this.events);
    return "claimed";
  }

  private prune() {
    const now = this.now();
    for (const entries of [this.desktops, this.events]) {
      for (const [key, expires] of entries) if (expires <= now) entries.delete(key);
    }
  }

  private trim(entries: Map<string, number>) {
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  }
}

const claims = new NotificationClaims();

export function handleNotificationHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TerminalServerOptions,
  broker = claims,
): boolean {
  if (!req.url?.startsWith("/notifications/")) return false;
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(req.headers.origin, opts) };
  const respond = (status: number, body?: unknown) => {
    res.writeHead(status, headers);
    res.end(body === undefined ? undefined : JSON.stringify(body));
    return true;
  };
  if (req.method === "OPTIONS") return respond(204);
  if (!authorizeLocalRequest(req, opts)) return respond(403, { error: "forbidden" });
  if (req.method !== "POST") return respond(405, { error: "method not allowed" });
  const url = new URL(req.url, "http://localhost");
  const p = url.searchParams;
  const scope = p.get("scope");
  if (!scope || scope.length > 500) return respond(400, { error: "invalid scope" });
  if (url.pathname === "/notifications/desktop") {
    const client = p.get("client");
    if (!client || client.length > 100) return respond(400, { error: "invalid client" });
    broker.desktop(scope, client, p.get("active") === "1");
    return respond(200, { ok: true });
  }
  if (url.pathname === "/notifications/claim") {
    const event = p.get("event");
    const ttl = Number(p.get("ttl"));
    if (!event || event.length > 2_000 || !Number.isFinite(ttl) || ttl < 100 || ttl > 180_000) {
      return respond(400, { error: "invalid event" });
    }
    return respond(200, { result: broker.claim(scope, event, p.get("desktop") === "1", ttl, p.get("preferDesktop") !== "0") });
  }
  return respond(404, { error: "not found" });
}
