// The unsubscribe endpoint's responses, ported from codecast's http.ts route.
// GET serves the human clicking the footer link; POST serves RFC 8058 one
// click (fired without opening a page). The app owns the route itself.

import { type Brand, resolveBrand } from "../brand";

export function unsubscribeResponse(args: {
  ok: boolean;
  method: string;
  brand: Brand;
  /** Where "notification settings" points, e.g. `${brand.url}/settings/notifications`. */
  settingsUrl: string;
}): Response {
  if (args.method === "POST") {
    return new Response(args.ok ? "ok" : "unknown token", { status: args.ok ? 200 : 404 });
  }
  const brand = resolveBrand(args.brand);
  const p = brand.palette;
  const body = args.ok
    ? `<h1>You're unsubscribed</h1><p>${brand.name} will no longer email you notification digests. Turn them back on any time in <a href="${args.settingsUrl}">notification settings</a>.</p>`
    : `<h1>Link expired</h1><p>This unsubscribe link is no longer valid. Manage email in <a href="${args.settingsUrl}">notification settings</a>.</p>`;
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${brand.name}</title><style>body{font-family:${brand.fontStack};background:${p.bodyBg};color:${p.text};display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{background:${p.cardBg};border:1px solid ${p.border};border-top:3px solid ${p.accent};border-radius:14px;padding:40px;max-width:440px}h1{font-size:20px;margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0}a{color:${p.accentDark}}</style></head><body><main>${body}</main></body></html>`,
    { status: args.ok ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
