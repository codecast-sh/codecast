// Recall and showing: docs, memory, search, session blame, published pages
// and the visual canvas ("recall-showing" in ../shots-desktop.json), plus the
// main docs page's doc image.
import type { Shot, Step } from "../manifest";
import { SESSIONS } from "../../lib/acmeWorld/world";
import { RECALL_SESSION } from "../../lib/acmeWorld/recall";
import { RETRY_SPEC_ID } from "../../lib/acmeWorld/docs";
import { CAP_SHA, CODE_FILE, CODE_REPO } from "../../lib/acmeWorld/code";

const RECALL = `/conversation/${RECALL_SESSION._id}`;
const BLOB = `/repo/${CODE_REPO}/blob/main?path=${encodeURIComponent(CODE_FILE)}`;
/** Opens `path` from the inbox, so its back link reads Inbox whatever the shot before showed. */
const from = (path: string): Step[] => [{ js: `history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"))` }, { sleep: 1500 }];

/** Blame set to Sessions, once the session strip has painted. */
const SESSION_BLAME = [{ click: "[role=radio]", text: "Sessions" }, { wait: ".repo-session-chip" }, { sleep: 600 }];

export const RECALL_SHOWING: Shot[] = [
  /* ── Main docs page ──────────────────────────────────────────────────── */
  {
    name: "app/doc",
    route: "/inbox",
    viewport: { width: 1280, height: 860 },
    steps: [
      ...from(`/docs/${RETRY_SPEC_ID}`),
      { wait: ".doc-editor-content", text: "Retry queue for failed webhooks" },
      { sleep: 800 },
    ],
    frame: "window",
    out: "public/docs/app/doc.webp",
  },

  /* ── Ambient awareness and memory ────────────────────────────────────── */
  {
    name: "ambient-awareness/stable-context",
    route: "/inbox",
    viewport: { width: 1200, height: 800 },
    steps: [...from(RECALL), { wait: "[data-sv-feed] button[aria-expanded]", text: "session pointers" }, { js: `document.querySelector("button[aria-expanded=false]:has(.lucide-layers)")?.click()` }, { wait: "button[aria-expanded=true]", text: "session pointers" }, { sleep: 600 }, { js: `document.querySelector("div.conv-col:has(> button[aria-expanded=true])").scrollIntoView({ block: "center" })` }, { sleep: 600 }],
    crop: { selector: "div.conv-col:has(> button[aria-expanded=true])", pad: 16 },
    frame: "element",
    out: "public/documentation/ambient-awareness/stable-context.webp",
  },
  {
    name: "ambient-awareness/new-session-context",
    route: "/inbox",
    viewport: { width: 1280, height: 860 },
    steps: [
      { js: `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New session").click()` },
      { wait: "button[aria-expanded]", text: "Context" },
      { js: `document.querySelector("button[aria-expanded=false]:has(.lucide-layers)")?.click()` },
      { wait: "button", text: "Solo" },
      { js: `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Team").click()` },
      { wait: "button[title='Exclude from context']" },
      { js: `document.querySelectorAll("button[title='Exclude from context']")[2].click()` },
      { sleep: 800 },
    ],
    crop: { selector: "div:has(> div > button[aria-expanded=true] .lucide-layers)", pad: 16 },
    frame: "element",
    out: "public/documentation/ambient-awareness/new-session-context.webp",
  },
  {
    name: "memory/agent-features",
    route: "/agent-features",
    viewport: { width: 1280, height: 1000 },
    crop: { selector: "#af-context", pad: 16 },
    frame: "element",
    out: "public/documentation/memory/agent-features.webp",
  },
  {
    name: "memory/conversation",
    route: "/inbox",
    viewport: { width: 1100, height: 900 },
    steps: [...from(RECALL), 
      { wait: "[data-sv-feed]", text: "Because Maya measured it" },
      // Folded, as a conversation opens; the strip keeps its open state from the shot before.
      { js: `document.querySelector("button[aria-expanded=true]:has(.lucide-layers)")?.click(); document.activeElement?.blur()` },
      { sleep: 800 },
    ],
    frame: "window",
    out: "public/documentation/memory/conversation.webp",
  },

  /* ── Search ──────────────────────────────────────────────────────────── */
  {
    name: "search-sessions-across-machines/search",
    route: "/search",
    viewport: { width: 1200, height: 860 },
    steps: [
      { click: "input[placeholder*=phrases]" },
      { type: "webhook retry" },
      { wait: "[data-search-session]" },
      { js: `[...document.querySelectorAll("button")].find((b) => /^Sessions\\s*\\d/.test(b.textContent.trim()))?.click()` },
      { sleep: 1000 },
      { js: `document.activeElement?.blur()` },
    ],
    frame: "window",
    out: "public/documentation/search-sessions-across-machines/search.webp",
  },
  {
    name: "search-sessions-across-machines/palette",
    route: "/inbox",
    viewport: { width: 1280, height: 800 },
    steps: [{ js: "__inboxStore.getState().openPalette()" }, { wait: "[cmdk-root]" }, { type: "webhook" }, { sleep: 1500 }],
    crop: { selector: "[cmdk-root]", pad: 40 },
    frame: "element",
    out: "public/documentation/search-sessions-across-machines/palette.webp",
  },
  {
    name: "search-sessions-across-machines/filters",
    route: "/search",
    viewport: { width: 1200, height: 760 },
    frame: "window",
    out: "public/documentation/search-sessions-across-machines/filters.webp",
  },

  /* ── Which session wrote this line ───────────────────────────────────── */
  {
    name: "which-session-wrote-this-line/session-blame",
    route: "/inbox",
    viewport: { width: 1280, height: 900 },
    steps: [...from(BLOB), ...SESSION_BLAME],
    frame: "window",
    out: "public/documentation/which-session-wrote-this-line/session-blame.webp",
  },
  {
    name: "which-session-wrote-this-line/chip-hover",
    route: "/inbox",
    viewport: { width: 1280, height: 900 },
    steps: [...from(BLOB), ...SESSION_BLAME, { hover: ".repo-session-chip button", text: "Backoff" }, { sleep: 500 }],
    frame: "window",
    out: "public/documentation/which-session-wrote-this-line/chip-hover.webp",
  },
  {
    name: "which-session-wrote-this-line/commit-session",
    route: "/inbox",
    viewport: { width: 1200, height: 800 },
    steps: from(`/commit/${CODE_REPO}/${CAP_SHA}`),
    frame: "window",
    out: "public/documentation/which-session-wrote-this-line/commit-session.webp",
  },

  /* ── Publish ─────────────────────────────────────────────────────────── */
  // A published page is served by Convex HTTP, not the app: ../published-pages.ts renders it with the real
  // presentation code and captures these raws (run it before this batch when the page changes).
  {
    name: "publish/page",
    raw: "packages/web/docs-shots/raw/publish/page.png",
    frame: "window",
    title: "codecast.sh/a/acme-webhook-retry-failures",
    out: "public/documentation/publish/page.webp",
  },
  {
    name: "publish/manage",
    raw: "packages/web/docs-shots/raw/publish/manage.png",
    frame: "element",
    out: "public/documentation/publish/manage.webp",
  },
  {
    name: "publish/embed",
    raw: "packages/web/docs-shots/raw/publish/embed.png",
    frame: "element",
    out: "public/documentation/publish/embed.webp",
  },
  {
    name: "publish/pages-list",
    route: "/inbox",
    viewport: { width: 1280, height: 860 },
    steps: from("/artifacts"),
    frame: "window",
    out: "public/documentation/publish/pages-list.webp",
  },
  {
    name: "publish/publish-feature",
    route: "/agent-features",
    viewport: { width: 1280, height: 900 },
    steps: [{ click: "[data-feature-card=publish]" }, { wait: "[role=dialog][data-state=open]" }, { sleep: 800 }],
    crop: { selector: "[role=dialog][data-state=open]", pad: 24 },
    frame: "element",
    out: "public/documentation/publish/publish-feature.webp",
  },

  /* ── Visual canvas ───────────────────────────────────────────────────── */
  {
    name: "visual-canvas/conversation",
    route: "/inbox",
    viewport: { width: 1100, height: 900 },
    steps: [...from(`/conversation/${SESSIONS.ui._id}`), { wait: "[data-sv-feed]", text: "I replayed last week" }, { sleep: 1500 }],
    frame: "window",
    out: "public/documentation/visual-canvas/conversation.webp",
  },
  {
    name: "visual-canvas/visual-feature",
    route: "/agent-features",
    viewport: { width: 1280, height: 900 },
    steps: [{ click: "[data-feature-card=visual]" }, { wait: "[role=dialog][data-state=open]" }, { sleep: 800 }],
    crop: { selector: "[role=dialog][data-state=open]", pad: 24 },
    frame: "element",
    out: "public/documentation/visual-canvas/visual-feature.webp",
  },
];
