// "working-together-a" in ../shots-desktop.json (decisions, messaging, forks,
// calls, team chat), plus the main page's decision and call images.
import type { Shot } from "../manifest";
import { DECISION_SESSIONS } from "../../lib/acmeWorld/decisions";
import { FORK_SESSIONS } from "../../lib/acmeWorld/forks";
import { CALL_ID, RECAP_SESSION } from "../../lib/acmeWorld/calls";

const D = DECISION_SESSIONS;
const conv = (id: string) => `/conversation/${id}`;
/** Full density: every tool call as its own card (a `cast send` as its Message to card), not folded into a receipt. */
const FULL = { js: "__inboxStore.getState().updateClientUI({ simple_view: false })" };

export const WORKING_TOGETHER_A: Shot[] = [
  /* ── Decisions ─────────────────────────────────────────────────────────── */
  {
    name: "app/decisions",
    // The full card on the asking session's pane, as the queue opens it from an inbox card.
    route: `/decisions?s=${D.retries._id}`,
    viewport: { width: 1280, height: 820 },
    steps: [{ sleep: 800 }],
    crop: { selector: "[data-session-decision]", pad: 0 },
    frame: "element",
    out: "public/docs/app/decisions.webp",
  },
  {
    name: "decisions/waiting",
    route: conv(D.retries._id),
    viewport: { width: 1280, height: 820 },
    crop: { selector: "[data-session-decision]", pad: 0 },
    frame: "element",
    out: "public/documentation/decisions/waiting.webp",
  },
  {
    name: "decisions/decisions-page",
    route: "/decisions",
    // The tabs fold into a menu below a 1235px header (ListViewHeader .cq-tabs-compact).
    viewport: { width: 1800, height: 720 },
    frame: "window",
    out: "public/documentation/decisions/decisions-page.webp",
  },
  {
    name: "decisions/one-at-a-time",
    route: "/decisions?mode=step",
    viewport: { width: 1280, height: 820 },
    ready: "[data-session-decision]",
    steps: [{ sleep: 800 }, { wait: "[data-session-decision]" }],
    frame: "window",
    out: "public/documentation/decisions/one-at-a-time.webp",
  },
  {
    name: "decisions/answered",
    route: conv(D.retries._id),
    viewport: { width: 1100, height: 1100 },
    steps: [{ js: "__acmeScene.answered()" }, { wait: "[data-sv-feed]" }, { sleep: 1200 }],
    crop: { selector: "[data-sv-feed]", pad: 0 },
    frame: "element",
    out: "public/documentation/decisions/answered.webp",
  },
  {
    name: "decisions/steer-dock",
    route: conv(D.deadLetters._id),
    // Short, so the conversation pane is mostly the docked question and the message box under it.
    viewport: { width: 1100, height: 680 },
    ready: "[data-session-decision]",
    crop: { selector: "main[data-cc-conversation]", pad: 0 },
    frame: "element",
    out: "public/documentation/decisions/steer-dock.webp",
  },

  {
    name: "messaging/triage-menu",
    route: conv(D.deadLetters._id),
    viewport: { width: 1280, height: 820 },
    rail: true,
    steps: [{ rightClick: `[data-sv-rail] [data-session-id="${D.deadLetters._id}"]` }, { sleep: 700 }],
    frame: "window",
    out: "public/documentation/messaging/triage-menu.webp",
  },
  /* ── Messaging ─────────────────────────────────────────────────────────── */
  {
    name: "messaging/message-from",
    route: conv(D.queue._id),
    viewport: { width: 1100, height: 1400 },
    steps: [FULL, { wait: "[data-sv-feed]", text: "Message to" }, { sleep: 1000 }],
    crop: { selector: "[data-sv-feed]", pad: 0 },
    frame: "element",
    out: "public/documentation/messaging/message-from.webp",
  },

  /* ── Forks and workers ─────────────────────────────────────────────────── */
  {
    name: "forks-and-spawn/workers",
    route: conv(D.retries._id),
    viewport: { width: 1100, height: 1300 },
    steps: [
      FULL,
      // Before the question: parked on its two workers, so the pane shows the thread.
      { js: "__acmeScene.nest()" },
      { wait: "[data-sv-feed]", text: "Both workers are done" },
      { js: "document.querySelector('[data-sv-feed]').scrollTo(0, 0)" },
      { sleep: 1200 },
    ],
    crop: { selector: "[data-sv-feed]", pad: 0 },
    frame: "element",
    out: "public/documentation/forks-and-spawn/workers.webp",
  },
  {
    name: "forks-and-spawn/branch-map",
    route: conv(FORK_SESSIONS.queue._id),
    viewport: { width: 1100, height: 820 },
    steps: [{ wait: "[data-sv-feed]" }, { click: "[data-sv-feed]" }, { sleep: 600 }, { key: "Control+b" }, { sleep: 1200 }],
    frame: "window",
    out: "public/documentation/forks-and-spawn/branch-map.webp",
  },


  {
    name: "forks-and-spawn/fork-from-message",
    route: conv(FORK_SESSIONS.queue._id),
    viewport: { width: 1100, height: 820 },
    steps: [{ wait: "[data-sv-feed] p", text: "The queue holds up" }, { hover: "[data-sv-feed] p", text: "The queue holds up" }, { rightClick: "[data-sv-feed] p", text: "The queue holds up" }, { sleep: 600 }, { hover: "[role=menuitem]", text: "Fork from here" }, { sleep: 400 }],
    frame: "window",
    out: "public/documentation/forks-and-spawn/fork-from-message.webp",
  },
  {
    name: "forks-and-spawn/move-menu",
    route: conv(FORK_SESSIONS.queue._id),
    viewport: { width: 1100, height: 760 },
    steps: [{ wait: "[data-sv-feed]" }, { click: "[data-session-control-trigger=composer]" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/forks-and-spawn/move-menu.webp",
  },

  /* ── Calls ─────────────────────────────────────────────────────────────── */
  {
    name: "app/call",
    route: `/calls/${CALL_ID}`,
    viewport: { width: 1280, height: 860 },
    ready: "[data-cc-shell]",
    steps: [{ wait: "main", text: "Makes sense. Sarah" }, { sleep: 600 }],
    frame: "window",
    out: "public/docs/app/call.webp",
  },
  {
    name: "calls/call-page",
    route: `/calls/${CALL_ID}`,
    viewport: { width: 1280, height: 860 },
    steps: [{ wait: "main", text: "Makes sense. Sarah" }, { click: "button", text: "Summary" }, { sleep: 700 }],
    frame: "window",
    out: "public/documentation/calls/call-page.webp",
  },
  {
    name: "calls/digest",
    route: "/chat",
    viewport: { width: 1200, height: 800 },
    ready: ".ch-msg:has(.ch-call-head)",
    crop: { selector: ".ch-msg:has(.ch-call-head)", pad: 12 },
    frame: "element",
    out: "public/documentation/calls/digest.webp",
  },
  {
    name: "calls/agent-quote",
    route: conv(RECAP_SESSION._id),
    viewport: { width: 1100, height: 820 },
    steps: [{ wait: "[data-sv-feed]", text: "Fine by me" }, { sleep: 800 }],
    crop: { selector: "[data-sv-feed]", pad: 0 },
    frame: "element",
    out: "public/documentation/calls/agent-quote.webp",
  },

  /* ── Team chat ─────────────────────────────────────────────────────────── */
  {
    name: "team-chat/channel",
    route: "/chat",
    viewport: { width: 1280, height: 820 },
    ready: ".ch-thread-link",
    frame: "window",
    out: "public/documentation/team-chat/channel.webp",
  },
  {
    name: "team-chat/mention-picker",
    route: "/chat",
    viewport: { width: 1200, height: 760 },
    ready: "[data-chat-input]",
    steps: [{ click: ".ch-composer [data-chat-input]" }, { type: "@" }, { sleep: 900 }],
    frame: "window",
    out: "public/documentation/team-chat/mention-picker.webp",
  },
  {
    name: "team-chat/session-thread",
    route: "/chat",
    viewport: { width: 1280, height: 820 },
    ready: ".ch-thread-link",
    steps: [{ click: ".ch-thread-link" }, { wait: "aside.ch-thread", text: "evt_1Q8" }, { sleep: 600 }],
    crop: { selector: "aside.ch-thread", pad: 0 },
    frame: "element",
    out: "public/documentation/team-chat/session-thread.webp",
  },

  {
    name: "team-chat/slack-mirror",
    route: "/chat",
    viewport: { width: 1200, height: 1000 },
    ready: "button[data-nav-subrow][title=eng]",
    steps: [
      { rightClick: "button[data-nav-subrow][title=eng]" },
      { click: "[role=menuitem]", text: "Mirror with Slack" },
      { wait: ".ch-slack-dialog button.ch-slack-row", text: "eng" },
      { click: ".ch-slack-dialog button.ch-slack-row", text: "eng" },
      { click: ".ch-slack-dialog button", text: "Last week" },
      { sleep: 500 },
    ],
    crop: { selector: ".ch-slack-dialog", pad: 0 },
    frame: "element",
    out: "public/documentation/team-chat/slack-mirror.webp",
  },

  {
    name: "forks-and-spawn/inbox-nest",
    route: conv(D.retries._id),
    viewport: { width: 1280, height: 860 },
    rail: true,
    steps: [{ js: "__acmeScene.nest()" }, { sleep: 1200 }],
    crop: { selector: "[data-sv-rail]", pad: 0 },
    frame: "element",
    out: "public/documentation/forks-and-spawn/inbox-nest.webp",
  },
  // The live #eng huddle, joined in this tab (__acmeScene.huddle in lib/acmeWorld/calls.ts).
  {
    name: "calls/in-call",
    route: "/chat",
    viewport: { width: 1280, height: 820 },
    steps: [
      { js: "__acmeScene.huddle()" },
      { wait: "[data-open-call]" },
      { click: "[data-open-call]" },
      { wait: ".call-stage" },
      { click: ".call-stage button[aria-label^='Open the thread']" },
      { wait: ".call-stage aside", text: "Two tests on the one-hour cap" },
      { sleep: 900 },
    ],
    frame: "window",
    out: "public/documentation/calls/in-call.webp",
  },
  {
    name: "calls/huddle-agent",
    route: "/chat",
    viewport: { width: 1280, height: 820 },
    steps: [
      { js: "__acmeScene.huddle()" },
      { wait: "[data-open-call]" },
      { js: "document.querySelector('.call-stage') || document.querySelector('[data-open-call]').click()" },
      { wait: ".call-stage" },
      { js: "document.querySelector('.call-stage aside') || document.querySelector(\".call-stage button[aria-label^='Open the thread']\").click()" },
      { wait: ".call-stage aside", text: "Two tests on the one-hour cap" },
      { sleep: 900 },
    ],
    crop: { selector: ".call-stage aside", pad: 0 },
    frame: "element",
    out: "public/documentation/calls/huddle-agent.webp",
  },

  // Last: it splits the tab's stage, which later shots on the same tab would inherit.
  {
    name: "shots/session-messages",
    route: conv(D.queue._id),
    viewport: { width: 1440, height: 900 },
    steps: [
      // Hang up the huddle the call shots joined, so no call chrome rides along.
      { js: "__inboxStore.getState().setCallState({ phase: 'idle', roomKey: null })" },
      FULL,
      { wait: "[data-sv-feed]" },
      { js: `__inboxStore.getState().stageInsertLeaf("root", "right", "${conv(D.hooksApi._id)}", { focus: false })` },
      { sleep: 2500 },
    ],
    frame: "window",
    out: "public/documentation/shots/session-messages.webp",
  },
];
