// The docs page's own images (public/docs/app), "main-page" in ../shots-desktop.json.
import type { Shot, Step } from "../manifest";
import { SESSIONS } from "../../lib/acmeWorld/world";

/** The transcript at its end, the way an open conversation sits while it runs. */
export const TRANSCRIPT_END: Step[] = [
  { wait: "[data-sv-feed]" },
  {
    js: `(async () => {
      for (let i = 0; i < 6; i++) {
        for (let n = document.querySelector("[data-sv-feed]"); n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 4) n.scrollTop = n.scrollHeight;
        await new Promise((r) => setTimeout(r, 300));
      }
    })()`,
  },
];

export const MAIN_PAGE: Shot[] = [
  {
    name: "inbox",
    // The lead session open, mid-run, beside the inbox column.
    route: `/conversation/${SESSIONS.lead._id}`,
    steps: TRANSCRIPT_END,
    viewport: { width: 1360, height: 860 },
    rail: true,
    frame: "window",
    out: "public/docs/app/inbox.webp",
  },
  {
    name: "app/inbox-cards",
    route: `/conversation/${SESSIONS.lead._id}`,
    steps: TRANSCRIPT_END,
    viewport: { width: 1360, height: 1600 },
    rail: true,
    crop: { selector: "[data-sv-rail]", pad: 0 },
    frame: "element",
    out: "public/docs/app/inbox-cards.webp",
  },
  {
    name: "conversation",
    route: `/conversation/${SESSIONS.lead._id}`,
    steps: TRANSCRIPT_END,
    viewport: { width: 1180, height: 900 },
    frame: "window",
    out: "public/docs/app/conversation.webp",
  },
  {
    name: "app/permission",
    route: `/conversation/${SESSIONS.lead._id}`,
    steps: TRANSCRIPT_END,
    viewport: { width: 1180, height: 900 },
    crop: { selector: "[data-permission-card]", include: '[data-cc-message="assistant"]', pad: 12 },
    frame: "element",
    out: "public/docs/app/permission.webp",
  },
  {
    name: "app/diff",
    route: `/conversation/${SESSIONS.lead._id}/diff`,
    steps: TRANSCRIPT_END,
    viewport: { width: 1440, height: 900 },
    frame: "window",
    out: "public/docs/app/diff.webp",
  },
  {
    name: "palette",
    route: "/inbox",
    viewport: { width: 1280, height: 800 },
    steps: [{ js: `__inboxStore.getState().openPalette({ initialQuery: "retry" })` }, { wait: "[cmdk-root]" }, { sleep: 900 }],
    frame: "window",
    out: "public/docs/app/palette.webp",
  },
  {
    name: "changes",
    route: "/changes",
    viewport: { width: 1100, height: 900 },
    frame: "window",
    out: "public/docs/app/changes.webp",
  },
  {
    name: "chat",
    route: "/chat",
    viewport: { width: 1200, height: 720 },
    frame: "window",
    out: "public/docs/app/chat.webp",
  },
  {
    name: "mobile",
    // The phone's inbox from its own store shots (packages/mobile/store-shots), the same world.
    raw: "packages/mobile/store-shots/raw/docs/phone-inbox.png",
    frame: "phone",
    out: "public/docs/app/mobile.webp",
  },
];
