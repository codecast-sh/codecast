// Per-app link previews. The shell is static, so a link unfurler would only
// ever see its site-wide defaults. /og/<slug> on the deployment serves an
// app's own tags (and sends any person who lands there on to the app), and
// whatever serves the shell hands an unfurler asking for an app link that
// page instead of index.html (unfurlSlug), so every copied link unfurls as
// its app.
import { isSlug } from "./slugs";

/** Link preview fetchers: messengers, social sites and chat apps. iMessage
 *  fetches as facebookexternalhit and Twitterbot. */
const UNFURLERS = /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|linkedinbot|whatsapp|telegrambot|skypeuripreview|redditbot|embedly|pinterest|mastodon|bluesky|googlebot|bingbot|applebot|iframely/i;

/** The app whose preview an unfurler fetching `pathname` should get, or null
 *  to serve the shell as usual. */
export function unfurlSlug(pathname: string, userAgent: string | null | undefined): string | null {
  if (!userAgent || !UNFURLERS.test(userAgent)) return null;
  const m = /^\/([^/]+)(?:\/v\/\d+)?\/?$/.exec(pathname);
  return m && isSlug(m[1]) ? m[1] : null;
}

/** `image`: the live version's still, when a screen has taken one. */
export type UnfurlApp = { name: string; summary: string | null; version: number; contributors: number; image: string | null };

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "38 people changed it · v14" (DESIGN 7). */
export function unfurlFacts(app: UnfurlApp): string {
  const people = app.contributors === 1 ? "1 person changed it" : `${app.contributors} people changed it`;
  return `${people} · v${app.version}`;
}

/** The tags an unfurler reads, and a refresh to the app for everyone else. */
export function unfurlHtml(app: UnfurlApp, url: string): string {
  const title = escape(`${app.name} · Clayground`);
  const description = escape(app.summary ? `${app.summary}. ${unfurlFacts(app)}` : unfurlFacts(app));
  const href = escape(url);
  const image = app.image
    ? `<meta property="og:image" content="${escape(app.image)}" />\n<meta name="twitter:card" content="summary_large_image" />`
    : `<meta name="twitter:card" content="summary" />`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta property="og:site_name" content="Clayground" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escape(app.name)}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${href}" />
${image}
<link rel="canonical" href="${href}" />
<meta http-equiv="refresh" content="0; url=${href}" />
</head>
<body><a href="${href}">${escape(app.name)}</a></body>
</html>`;
}
