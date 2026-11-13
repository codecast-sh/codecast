// "working-together-b" in ../shots-desktop.json, plus the main page's Team and
// Sync & Privacy settings. Sessions come from lib/acmeWorld/conversations.ts,
// the folders from lib/acmeWorld/sharing.ts, the team feed from
// lib/acmeWorld/teamActivity.ts.
import type { Shot, Step } from "../manifest";
import { CONVERSATIONS, SHARED_MESSAGE_TOKEN } from "../../lib/acmeWorld/conversations";

const conversation = (c: { _id: string }) => `/conversation/${c._id}`;
const BACKOFF = conversation(CONVERSATIONS.backoff);
const SHEET = "[role=dialog] > div";
const PANE = "main[data-cc-conversation]";

/** A settings route opens as a sheet over the page; later shots close it the way the app does. */
const closeSheet: Step = { js: "__inboxStore.getState().closeSettingsModal?.()" };
/** The sheet caps its height; let it grow to its content so one capture holds the whole panel. */
const growSheet: Step = {
  js: `(() => { const d = document.querySelector(${JSON.stringify(SHEET)}); d.style.height = "auto"; d.style.maxHeight = "none"; for (const e of d.querySelectorAll(".overflow-y-auto, .overflow-auto")) e.style.overflow = "visible"; })()`,
};
/** Marks the row of one folder on the sharing list, so a crop can name it. */
const markRow = (folder: string): Step => ({
  js: `(() => { const t = [...document.querySelectorAll('button[aria-label="Who can open ${folder}"]')][0]; let e = t; while (e && !(e.parentElement && e.parentElement.querySelectorAll('button[aria-label^="Who can open"]').length > 1)) e = e.parentElement; e.setAttribute("data-shot-row", ""); })()`,
});
const scrollPane = (to: "top" | "bottom"): Step => ({
  js: `(() => { const m = document.querySelector(${JSON.stringify(PANE)}); for (const e of m.querySelectorAll("*")) if (e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible") e.scrollTop = ${to === "top" ? 0 : "e.scrollHeight"}; })()`,
});

export const WORKING_TOGETHER_B: Shot[] = [
  {
    name: "app/team-settings",
    route: "/settings/team",
    viewport: { width: 1200, height: 900 },
    steps: [{ wait: SHEET, text: "Members" }, growSheet, { sleep: 500 }],
    crop: { selector: SHEET },
    frame: "element",
    out: "public/docs/app/team-settings.webp",
  },
  {
    name: "app/sharing",
    route: "/settings/sync",
    viewport: { width: 1200, height: 900 },
    steps: [{ wait: SHEET, text: "acme-api" }, growSheet, { sleep: 500 }],
    crop: { selector: SHEET },
    frame: "element",
    out: "public/docs/app/sharing.webp",
  },
  {
    name: "team-sessions/sharing-settings",
    route: "/settings/sync",
    viewport: { width: 1200, height: 900 },
    steps: [
      { wait: SHEET, text: "webhooks" },
      growSheet,
      { click: 'button[aria-label="Who can open webhooks"]' },
      { wait: "[data-share-panel]" },
      { js: `[...document.querySelectorAll("h2,h3,div")].find((e) => e.childElementCount <= 3 && e.textContent.trim() === "Sharing").closest("section, [data-settings-section]")?.setAttribute("data-shot-section", "") ?? (() => { let e = document.querySelector("[data-share-panel]"); for (let i = 0; i < 4; i++) e = e.parentElement; e.setAttribute("data-shot-section", ""); })()` },
      { sleep: 500 },
    ],
    crop: { selector: "[data-shot-section]", pad: 8 },
    frame: "element",
    out: "public/documentation/team-sessions/sharing-settings.webp",
  },
  {
    name: "team-sessions/share-review",
    route: "/settings/sync",
    viewport: { width: 1200, height: 900 },
    steps: [
      { wait: SHEET, text: "billing-api" },
      growSheet,
      { click: 'button[aria-label="Who can open billing-api"]' },
      { wait: "[data-share-panel]" },
      { click: "[data-share-panel] [role=radio]", text: "Acme" },
      { wait: "[data-share-panel] [role=radiogroup]", text: "From today on" },
      { click: "[data-share-panel] label", text: "From today on" },
      markRow("billing-api"),
      { sleep: 800 },
    ],
    crop: { selector: "[data-shot-row]", include: "[data-share-panel]", pad: 8 },
    frame: "element",
    out: "public/documentation/team-sessions/share-review.webp",
  },
  {
    name: "team-sessions/activity",
    route: "/team/activity?project=billing",
    viewport: { width: 1280, height: 860 },
    steps: [closeSheet, { wait: "main", text: "Now" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/team-sessions/activity.webp",
  },
  {
    name: "shots/inbox",
    route: BACKOFF,
    viewport: { width: 1440, height: 900 },
    rail: true,
    steps: [closeSheet, { wait: PANE, text: "STAGING_API_KEY" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/shots/inbox.webp",
  },
  {
    name: "thread-state/pinned-panel",
    route: BACKOFF,
    viewport: { width: 1000, height: 800 },
    steps: [closeSheet, { wait: "[data-cc-thread-state]", text: "STAGING_API_KEY" }, { sleep: 600 }],
    crop: { selector: "[data-cc-thread-state]", include: "[data-cc-composer-box=dock]", pad: 12 },
    frame: "element",
    out: "public/documentation/thread-state/pinned-panel.webp",
  },
  {
    name: "thread-state/inbox-card",
    route: BACKOFF,
    viewport: { width: 1440, height: 860 },
    rail: true,
    steps: [closeSheet, { wait: `[data-mc=card][data-session-id="${CONVERSATIONS.backoff._id}"]` }, { sleep: 600 }],
    crop: { selector: "[data-sv-rail]" },
    frame: "element",
    out: "public/documentation/thread-state/inbox-card.webp",
  },
  {
    name: "share-a-session/share-popover",
    route: BACKOFF,
    viewport: { width: 1100, height: 760 },
    steps: [closeSheet, { wait: 'button[aria-label="Share session"]' }, { click: 'button[aria-label="Share session"]' }, { wait: "[data-radix-popper-content-wrapper]", text: "Link access" }, { sleep: 500 }],
    crop: { selector: 'button[aria-label="Share session"]', include: "[data-radix-popper-content-wrapper]", pad: 16 },
    frame: "element",
    out: "public/documentation/share-a-session/share-popover.webp",
  },
  {
    name: "share-a-session/share-messages",
    route: BACKOFF,
    viewport: { width: 1000, height: 860 },
    steps: [
      closeSheet,
      { wait: "#msg-hero-bk-m1" },
      { rightClick: "#msg-hero-bk-m1" },
      { click: "[role=menuitem]", text: "Share messages" },
      { click: "#msg-hero-bk-m3" },
      { click: "#msg-hero-bk-m4" },
      { wait: PANE, text: "3 messages selected" },
      { sleep: 500 },
    ],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/share-a-session/share-messages.webp",
  },
  {
    name: "share-a-session/shared-messages-page",
    route: `/share/message/${SHARED_MESSAGE_TOKEN}`,
    viewport: { width: 1100, height: 800 },
    ready: "body",
    steps: [closeSheet, { wait: "body", text: "View full conversation" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/share-a-session/shared-messages-page.webp",
  },
  {
    name: "opencode/codecast-session",
    route: conversation(CONVERSATIONS.opencode),
    viewport: { width: 1000, height: 900 },
    steps: [closeSheet, { wait: PANE, text: "All 14 tests pass" }, { click: `${PANE} button`, text: "Read 1 file" }, { sleep: 600 }, scrollPane("top"), { sleep: 400 }],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/opencode/codecast-session.webp",
  },
  {
    name: "opencode/codecast-follow-up",
    route: conversation(CONVERSATIONS.opencode),
    viewport: { width: 1000, height: 900 },
    steps: [closeSheet, { wait: PANE, text: "Capped." }, { click: `${PANE} button`, text: "1 edit" }, { sleep: 600 }, scrollPane("bottom"), { sleep: 400 }],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/opencode/codecast-follow-up.webp",
  },
  {
    name: "t3-code/codecast-session",
    route: conversation(CONVERSATIONS.t3),
    viewport: { width: 1000, height: 900 },
    steps: [closeSheet, { wait: PANE, text: "all 13 tests pass" }, { sleep: 600 }, scrollPane("top")],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/t3-code/codecast-session.webp",
  },
  {
    name: "opencode/codecast-new-session",
    route: "/inbox",
    viewport: { width: 1200, height: 800 },
    steps: [
      closeSheet,
      { js: `__inboxStore.getState().openCompose(undefined, { agentType: "opencode", projectPath: "~/src/billing", gitRoot: "~/src/billing" })` },
      { wait: "[data-cc-composer-box]" },
      { sleep: 1200 },
    ],
    crop: { selector: "[role=dialog]", pad: 0 },
    frame: "element",
    out: "public/documentation/opencode/codecast-new-session.webp",
  },
  {
    name: "agent-snippets/agent-features-intro",
    route: "/agent-features",
    viewport: { width: 1200, height: 860 },
    steps: [closeSheet, { wait: "h1", text: "Agent features" }, { sleep: 1000 }],
    frame: "window",
    out: "public/documentation/agent-snippets/agent-features-intro.webp",
  },
  {
    name: "agent-snippets/feature-group",
    route: "/agent-features",
    viewport: { width: 1200, height: 1100 },
    steps: [closeSheet, { wait: "h1", text: "Agent features" }, { sleep: 1000 }],
    frame: "window",
    out: "public/documentation/agent-snippets/feature-group.webp",
  },
  {
    name: "agent-snippets/feature-detail",
    route: "/agent-features?feature=memory",
    viewport: { width: 1200, height: 900 },
    steps: [closeSheet, { wait: "[role=dialog]", text: "Memory" }, { sleep: 1000 }],
    crop: { selector: "[role=dialog]", pad: 0 },
    frame: "element",
    out: "public/documentation/agent-snippets/feature-detail.webp",
  },
  {
    name: "sync-engine/sync-status",
    route: "/inbox",
    viewport: { width: 1280, height: 800 },
    steps: [
      closeSheet,
      // A cold first load: the projects feed still owes its first payload into an empty collection.
      { js: `(() => { const s = __inboxStore.getState(); s.setLiveLoading("projects", true); s.setLiveLoading("stashed", true); s.setLiveLoading("dismissed", false); })()` },
      { wait: '[aria-label^="Sync status"]' },
      { hover: '[aria-label^="Sync status"]' },
      { wait: "[data-radix-popper-content-wrapper]", text: "Sync status" },
      { sleep: 600 },
    ],
    crop: { selector: '[aria-label^="Sync status"]', include: "[data-radix-popper-content-wrapper]", pad: 16 },
    frame: "element",
    out: "public/documentation/sync-engine/sync-status.webp",
  },
  {
    name: "agent-snippets/new-features-banner",
    route: "/inbox",
    viewport: { width: 1200, height: 800 },
    steps: [
      closeSheet,
      { js: `(() => { const s = __inboxStore.getState(); for (const k of ["projects", "stashed", "dismissed"]) s.setLiveLoading(k, false); s.updateClientDismissed("snippet_intro_mods", 0); })()` },
      { wait: "button", text: "See what" },
      { click: "button", text: "See what" },
      { wait: "[role=dialog]", text: "New agent features" },
      { sleep: 800 },
    ],
    frame: "window",
    out: "public/documentation/agent-snippets/new-features-banner.webp",
  },
];

