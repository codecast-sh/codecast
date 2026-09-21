import type { MiddlewareHandler } from "hono";

export const responsePolicy: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), clipboard-read=(self), clipboard-write=(self)");
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.header("Content-Security-Policy-Report-Only", "script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  }
};
