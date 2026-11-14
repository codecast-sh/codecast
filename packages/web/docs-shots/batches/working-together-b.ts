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

/** Settings open as a sheet over the page, the way the gear menu opens them (a /settings route
 *  turns into the page beneath once the sheet is up); later shots close it the same way. */
const openSheet = (section: string): Step => ({ js: `__inboxStore.getState().openSettingsModal(${JSON.stringify(section)})` });
const closeSheet: Step = { js: "__inboxStore.getState().closeSettingsModal?.()" };
/** Scrolls the sheet's panel so the section headed `title` sits at the top (the sheet caps its height at 880px). */
const scrollTo = (title: string): Step => ({
  js: `(() => {
    const h = [...document.querySelectorAll(${JSON.stringify(SHEET)} + " *")].find((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(title)});
    let box = h.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    box.scrollTop += h.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
  })()`,
});
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
    route: "/inbox",
    viewport: { width: 1200, height: 900 },
    steps: [closeSheet, { sleep: 300 }, openSheet("team"), { wait: SHEET, text: "Members" }, scrollTo("Members"), { sleep: 3000 }],
    crop: { selector: SHEET },
    frame: "element",
    out: "public/docs/app/team-settings.webp",
  },
  {
    name: "app/sharing",
    route: "/inbox",
    viewport: { width: 1200, height: 960 },
    steps: [closeSheet, { sleep: 300 }, openSheet("sync"), { wait: SHEET, text: "acme-api" }, scrollTo("Sharing"), { sleep: 500 }],
    crop: { selector: SHEET },
    frame: "element",
    out: "public/docs/app/sharing.webp",
  },
  {
    name: "team-sessions/sharing-settings",
    route: "/inbox",
    viewport: { width: 1200, height: 900 },
    steps: [
      closeSheet,
      { sleep: 300 },
      openSheet("sync"),
      { wait: SHEET, text: "webhooks" },
      scrollTo("Sharing"),
      { click: 'button[aria-label="Who can open webhooks"]' },
      { wait: "[data-share-panel]" },
      { sleep: 500 },
    ],
    crop: { selector: SHEET },
    frame: "element",
    out: "public/documentation/team-sessions/sharing-settings.webp",
  },
  {
    name: "team-sessions/share-review",
    route: "/inbox",
    viewport: { width: 1200, height: 900 },
    steps: [
      closeSheet,
      { sleep: 300 },
      openSheet("sync"),
      { wait: SHEET, text: "billing-api" },
      // The script's pointer presses miss inside the sheet's scroller; DOM clicks are the same presses.
      { js: `(() => { document.querySelector('button[aria-label="Who can open billing-api"]').click(); })()` },
      { wait: "[data-share-panel]" },
      { js: `[...document.querySelectorAll("[data-share-panel] [role=radio]")].find((b) => b.textContent.includes("Acme")).click()` },
      { wait: "[data-share-panel] [role=radiogroup]", text: "From today on" },
      { js: `[...document.querySelectorAll("[data-share-panel] label")].find((l) => l.textContent.includes("From today on")).click()` },
      // Scroll once the panel is open, so the scroller can bring the row to the top.
      scrollTo("billing-api"),
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
    steps: [closeSheet, { wait: "body", text: "PRs merged" }, { sleep: 800 }],
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
    viewport: { width: 1440, height: 1500 },
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
      { wait: "#msg-hero-bk-m4" },
      // The script's CDP right press opens no React context menu here; a contextmenu event is the same
      // gesture. One awaited step, so the menu is used the moment it opens.
      {
        js: `(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const msg = (id) => document.querySelector("#msg-hero-bk-" + id);
          for (let i = 0; i < 20 && !document.querySelector("[role=menuitem]"); i++) {
            const r = msg("m4").getBoundingClientRect();
            msg("m4").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.x + 40, clientY: r.y + 20 }));
            await pause(500);
          }
          [...document.querySelectorAll("[role=menuitem]")].find((e) => e.textContent.includes("Share messages")).click();
          await pause(800);
          msg("m3").click();
          await pause(800);
          msg("m1").click();
          await pause(800);
        })()`,
      },
      { wait: PANE, text: "3 messages selected" },
      { sleep: 500 },
    ],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/share-a-session/share-messages.webp",
  },
  {
    name: "opencode/codecast-session",
    route: conversation(CONVERSATIONS.opencode),
    viewport: { width: 1000, height: 1100 },
    steps: [closeSheet, { wait: PANE, text: "All 14 tests pass" }, { js: `[...document.querySelectorAll("main [role=button]")].find((e) => e.textContent.startsWith("read 1 file")).click()` }, { sleep: 600 }, scrollPane("top"), { sleep: 400 }],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/opencode/codecast-session.webp",
  },
  // Between the two OpenCode shots: the script presses Escape before each shot, and Escape in an open
  // conversation interrupts its agent, so a shot never directly follows its own conversation.
  {
    name: "t3-code/codecast-session",
    route: conversation(CONVERSATIONS.t3),
    viewport: { width: 1000, height: 900 },
    steps: [closeSheet, { wait: PANE, text: "all 13 tests pass" }, { sleep: 600 }, scrollPane("top")],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/t3-code/codecast-session.webp",
  },  {
    name: "opencode/codecast-follow-up",
    route: conversation(CONVERSATIONS.opencode),
    viewport: { width: 1000, height: 900 },
    steps: [closeSheet, { wait: PANE, text: "Capped." }, { js: `[...document.querySelectorAll("main [role=button]")].find((e) => e.textContent.startsWith("1 edit · ran 1 command")).click()` }, { sleep: 600 }, scrollPane("bottom"), { sleep: 400 }],
    crop: { selector: PANE },
    frame: "element",
    out: "public/documentation/opencode/codecast-follow-up.webp",
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
    steps: [
      closeSheet,
      { wait: "h1", text: "Agent features" },
      { wait: "body", text: " on Alex" },
      // The count line closes the filter row: mark it so the crop can reach it.
      { js: `[...document.querySelectorAll("[data-main-scroll] *")].find((e) => /\\d+ of \\d+ on /.test(e.textContent) && e.textContent.length < 60).setAttribute("data-shot-count", "")` },
      { sleep: 800 },
    ],
    crop: { selector: "[data-main-scroll] header", include: "[data-shot-count]", pad: 16 },
    frame: "element",
    out: "public/documentation/agent-snippets/agent-features-intro.webp",
  },
  {
    name: "agent-snippets/feature-group",
    route: "/agent-features",
    viewport: { width: 1200, height: 2000 },
    steps: [
      closeSheet,
      { wait: "body", text: "Thread State" },
      // The Context group: the smallest block holding its heading and its three cards.
      { js: `[...document.querySelectorAll("[data-main-scroll] *")].filter((e) => e.textContent.includes("3 of 3 on") && e.textContent.includes("Thread State") && e.textContent.includes("Stable context")).pop().setAttribute("data-shot-group", "")` },
      { sleep: 800 },
    ],
    crop: { selector: "[data-shot-group]", pad: 16 },
    frame: "element",
    out: "public/documentation/agent-snippets/feature-group.webp",
  },
  {
    name: "agent-snippets/feature-detail",
    route: "/agent-features?feature=memory",
    viewport: { width: 1200, height: 900 },
    steps: [closeSheet, { wait: "[role=dialog][data-state=open]", text: "Memory" }, { sleep: 1000 }],
    crop: { selector: "[role=dialog][data-state=open]", pad: 0 },
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
  // Last: the public page has no app shell, so a shot after it would wait for the app to boot.
  {
    name: "share-a-session/shared-messages-page",
    route: `/share/message/${SHARED_MESSAGE_TOKEN}`,
    viewport: { width: 1100, height: 540 },
    ready: "body",
    steps: [closeSheet, { wait: "body", text: "View full conversation" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/share-a-session/shared-messages-page.webp",
  },
];

