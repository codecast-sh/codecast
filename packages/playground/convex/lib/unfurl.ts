// Per-app link previews. The shell is static, so a link unfurler would only
// ever see its site-wide defaults; /og/<slug> serves an app's own tags and
// sends any person who lands there on to the app.

export type UnfurlApp = { name: string; summary: string | null; version: number; contributors: number };

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
<meta name="twitter:card" content="summary" />
<link rel="canonical" href="${href}" />
<meta http-equiv="refresh" content="0; url=${href}" />
</head>
<body><a href="${href}">${escape(app.name)}</a></body>
</html>`;
}
