// Recall and showing: docs, memory, search, session blame, published pages
// and the visual canvas ("recall-showing" in ../shots-desktop.json), plus the
// main docs page's doc image.
import type { Shot } from "../manifest";
import { SESSIONS } from "../../lib/acmeWorld/world";
import { RECALL_SESSION } from "../../lib/acmeWorld/recall";
import { RETRY_SPEC_ID } from "../../lib/acmeWorld/docs";
import { CAP_SHA, CODE_FILE, CODE_REPO } from "../../lib/acmeWorld/code";

const RECALL = `/conversation/${RECALL_SESSION._id}`;
const BLOB = `/repo/${CODE_REPO}/blob/main?path=${encodeURIComponent(CODE_FILE)}`;
/** Blame set to Sessions, once the session strip has painted. */
const SESSION_BLAME = [{ click: "[role=radio]", text: "Sessions" }, { wait: ".repo-session-chip" }, { sleep: 600 }];

export const RECALL_SHOWING: Shot[] = [
  /* ── Main docs page ──────────────────────────────────────────────────── */
  {
    name: "app/doc",
    route: `/docs/${RETRY_SPEC_ID}`,
    viewport: { width: 1280, height: 860 },
    ready: ".doc-editor-content",
    frame: "window",
    out: "public/docs/app/doc.webp",
  },

  /* ── Ambient awareness and memory ────────────────────────────────────── */
  {
    name: "ambient-awareness/stable-context",
    route: RECALL,
    viewport: { width: 1200, height: 800 },
    steps: [{ wait: "[data-sv-feed] button[aria-expanded]", text: "session pointers" }, { click: "button[aria-expanded]", text: "session pointers" }, { sleep: 600 }],
    crop: { selector: "div.conv-col:has(> button[aria-expanded=true])", pad: 16 },
    frame: "element",
    out: "public/documentation/ambient-awareness/stable-context.webp",
  },
  {
    name: "ambient-awareness/new-session-context",
    route: "/inbox",
    viewport: { width: 1280, height: 860 },
    steps: [
      { click: "button", text: "New session" },
      { wait: "button[aria-expanded]", text: "Context" },
      { click: "button[aria-expanded]", text: "Context" },
      { click: "button", text: "Team" },
      { sleep: 800 },
    ],
    crop: { selector: "div:has(> div > button[aria-expanded=true])", pad: 16 },
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
    route: RECALL,
    viewport: { width: 1100, height: 900 },
    steps: [{ wait: "[data-sv-feed]", text: "Because Maya measured it" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/memory/conversation.webp",
  },

  /* ── Search ──────────────────────────────────────────────────────────── */
  {
    name: "search-sessions-across-machines/search",
    route: "/search?q=webhook%20retry",
    viewport: { width: 1200, height: 860 },
    steps: [{ wait: "[data-search-session]" }, { sleep: 800 }],
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
    route: BLOB,
    viewport: { width: 1280, height: 900 },
    steps: SESSION_BLAME,
    frame: "window",
    out: "public/documentation/which-session-wrote-this-line/session-blame.webp",
  },
  {
    name: "which-session-wrote-this-line/chip-hover",
    route: BLOB,
    viewport: { width: 1280, height: 900 },
    steps: [...SESSION_BLAME, { hover: ".repo-session-chip button", text: "Backoff" }, { sleep: 500 }],
    frame: "window",
    out: "public/documentation/which-session-wrote-this-line/chip-hover.webp",
  },
  {
    name: "which-session-wrote-this-line/commit-session",
    route: `/commit/${CODE_REPO}/${CAP_SHA}`,
    viewport: { width: 1200, height: 800 },
    frame: "window",
    out: "public/documentation/which-session-wrote-this-line/commit-session.webp",
  },

  /* ── Publish ─────────────────────────────────────────────────────────── */
  {
    name: "publish/pages-list",
    route: "/artifacts",
    viewport: { width: 1280, height: 860 },
    frame: "window",
    out: "public/documentation/publish/pages-list.webp",
  },
  {
    name: "publish/publish-feature",
    route: "/agent-features?feature=publish",
    viewport: { width: 1280, height: 900 },
    ready: "[role=dialog]",
    crop: { selector: "[role=dialog]", pad: 24 },
    frame: "element",
    out: "public/documentation/publish/publish-feature.webp",
  },

  /* ── Visual canvas ───────────────────────────────────────────────────── */
  {
    name: "visual-canvas/conversation",
    route: `/conversation/${SESSIONS.ui._id}`,
    viewport: { width: 1100, height: 900 },
    steps: [{ wait: "[data-sv-feed]", text: "Exponential backoff with jitter" }, { sleep: 1500 }],
    frame: "window",
    out: "public/documentation/visual-canvas/conversation.webp",
  },
  {
    name: "visual-canvas/visual-feature",
    route: "/agent-features?feature=visual",
    viewport: { width: 1280, height: 900 },
    ready: "[role=dialog]",
    crop: { selector: "[role=dialog]", pad: 24 },
    frame: "element",
    out: "public/documentation/visual-canvas/visual-feature.webp",
  },
];
