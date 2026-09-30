/**
 * Chapter 4, Approve (21 to 28s): the API worker asks to run a command; the
 * ask reaches the desk and the phone, and Approve on the phone lands back on
 * the desk. PLACEHOLDER: replace each placeholder part with the real views it
 * names, fed by ../fixtures/phone.ts. See README.md for the contract.
 */

import { placeholderFlyer, placeholderPart } from "../placeholderParts";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "phone",
  parts: [
    placeholderPart("phone", "permission", "desk.transcript", 30, "Permission stack", ["PermissionStackView"], 80),
    placeholderPart("phone", "phone", "phone.main", 0, "Phone: banner, then the permission card", ["NotificationRow", "iOS banner", "PhonePermissionCard (.dark)"]),
  ],
  flyers: {
    "phone.permission": placeholderFlyer("Permission needed"),
  },
};
