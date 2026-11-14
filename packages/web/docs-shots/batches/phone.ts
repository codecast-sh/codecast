// The phone images the docs pages show ("phone" in ../shots-phone.json),
// captured from the iOS app's store shots mode over the same Acme world
// (packages/mobile/store-shots/raw/docs) and framed here as a phone. The
// main page's inbox (public/docs/app/mobile.webp) lives in ./main-page.ts.
import type { Shot } from "../manifest";

const RAW = "packages/mobile/store-shots/raw/docs";
const phone = (name: string, raw: string, out: string): Shot => ({ name, raw: `${RAW}/${raw}.png`, frame: "phone", out });

export const PHONE_SHOTS: Shot[] = [
  phone("phone/session", "phone-session", "public/docs/app/mobile-session.webp"),
  phone("decisions/phone-decision", "phone-decision", "public/documentation/decisions/phone-decision.webp"),
  phone("calls/phone-call", "phone-call", "public/documentation/calls/phone-call.webp"),
  phone("team-chat/phone-chat", "phone-chat", "public/documentation/team-chat/phone-chat.webp"),
  phone("share-a-session/phone-share-sheet", "phone-share-sheet", "public/documentation/share-a-session/phone-share-sheet.webp"),
  phone("team-sessions/phone-inbox", "phone-inbox", "public/documentation/team-sessions/phone-inbox.webp"),
  phone("org-roles/phone", "phone-org", "public/documentation/org-roles/phone.webp"),
  phone("pull-requests/phone", "phone-pr", "public/documentation/pull-requests/phone.webp"),
  phone("tasks-and-plans/phone", "phone-tasks", "public/documentation/tasks-and-plans/phone.webp"),
  phone("triggers/phone", "phone-triggers", "public/documentation/triggers/phone.webp"),
  phone("ambient-awareness/phone-new-session", "phone-context-picker", "public/documentation/ambient-awareness/phone-new-session.webp"),
  phone("search-sessions-across-machines/phone-search", "phone-search", "public/documentation/search-sessions-across-machines/phone-search.webp"),
  phone("visual-canvas/phone-canvas", "phone-canvas", "public/documentation/visual-canvas/phone-canvas.webp"),
  phone("remote-and-cloud-sessions/phone-machine", "phone-machine", "public/documentation/remote-and-cloud-sessions/phone-machine.webp"),
];
