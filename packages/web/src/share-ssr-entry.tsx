import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SharedMessageNotFound, SharedMessageView } from "@/app/share/message/[token]/SharedMessageView";
import type { SharedMessageData } from "@/app/share/message/[token]/SharedMessageView";

/**
 * Request-time server render of the share pages (server/share.ts). Built into
 * dist-ssr/ by vite.prerender.config.ts alongside the marketing prerender; the
 * web server imports it if present and falls back to the payload-only shell
 * if not. Same view component the client hydrates, same props — the server
 * clock travels to the client inside window.__SHARE_PRELOAD__.
 *
 * MemoryRouter gives the compat <Link> its router context; hrefs render
 * identically under the client's BrowserRouter.
 */
export function renderShare(kind: string, path: string, data: unknown, now: number): string | null {
  if (kind !== "message") return null;
  const body = data === null
    ? <SharedMessageNotFound />
    : <SharedMessageView data={data as SharedMessageData} now={now} />;
  return renderToString(<MemoryRouter initialEntries={[path]}>{body}</MemoryRouter>);
}
