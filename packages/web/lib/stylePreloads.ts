// The boot script (plugins/handoffBoot.ts) adds a <link rel="preload" as="style">
// for each stylesheet the first screen needs, so the CSS downloads while the
// JavaScript is still loading. Once the app has booted those links have done
// their job, and leaving them in the document is what breaks the replay
// recorder's DOM capture (rrweb 2.1.7, @platform/analytics/replay):
//
// rrweb treats a preload link to a .css file as a stylesheet that has not
// loaded yet. It adds a "load" listener and a 5 second timer, and when either
// fires it serializes the link again, which starts the same wait again,
// because a preload link never gets a `sheet`. Every round adds one more
// listener to the link and emits one more event, and every 5,000 events rrweb
// takes a full snapshot that starts another round per link. After 12 hours a
// desktop window held 55,000 listeners on each of 8 links, and adding the next
// one took a fifth of the main thread (2026-11-15).
//
// So the links are removed before the recorder starts. The stylesheets
// themselves are separate <link rel="stylesheet"> elements and stay.

/** rrweb's own test for the links it waits on: rel is exactly "preload" and the href's file is .css. `as="style"` is the boot script's. */
function isStylePreload(link: Element): boolean {
  if ((link.getAttribute("rel") ?? "").trim().toLowerCase() !== "preload") return false;
  if ((link.getAttribute("as") ?? "").trim().toLowerCase() === "style") return true;
  const href = link.getAttribute("href") ?? "";
  return /\.css$/i.test(href.split(/[?#]/)[0]);
}

/** Remove every stylesheet preload link from the document. Returns how many it removed. */
export function dropStylePreloads(doc: Document | undefined = typeof document === "undefined" ? undefined : document): number {
  if (!doc) return 0;
  let removed = 0;
  for (const link of Array.from(doc.querySelectorAll("link[rel]"))) {
    if (!isStylePreload(link)) continue;
    link.remove();
    removed++;
  }
  return removed;
}
