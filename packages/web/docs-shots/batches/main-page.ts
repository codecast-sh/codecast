// The docs page's own images (public/docs/app), "main-page" in ../shots-desktop.json.
import type { Shot } from "../manifest";
import { PLANS, SESSIONS } from "../../lib/acmeWorld/world";

const PLAN_ID = PLANS(0)[0]._id;

export const MAIN_PAGE: Shot[] = [
  {
    name: "inbox",
    route: "/inbox",
    viewport: { width: 1280, height: 800 },
    frame: "window",
    out: "public/docs/app/inbox.webp",
  },
  {
    name: "conversation",
    route: `/conversation/${SESSIONS.api._id}`,
    viewport: { width: 1100, height: 900 },
    frame: "window",
    out: "public/docs/app/conversation.webp",
  },
  {
    name: "palette",
    route: "/inbox",
    viewport: { width: 1280, height: 800 },
    steps: [{ js: "__inboxStore.getState().openPalette()" }, { wait: "[cmdk-root]" }, { sleep: 600 }],
    crop: { selector: "[cmdk-root]", pad: 40 },
    frame: "element",
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
    name: "tasks",
    route: "/tasks",
    viewport: { width: 1100, height: 700 },
    frame: "window",
    out: "public/docs/app/tasks.webp",
  },
  {
    name: "plan",
    route: `/plans/${PLAN_ID}`,
    viewport: { width: 1100, height: 760 },
    frame: "window",
    out: "public/docs/app/plan.webp",
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
