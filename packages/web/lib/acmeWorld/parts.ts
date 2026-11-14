// The Acme world beyond its core (./world): one part per surface, each in its
// own file, so sessions adding to the world never edit the same lines. A part
// may add sessions to the inbox, write rows into the store through its sync
// writers, and answer queries the offline client (./convexStub) receives.
// Adding a surface is one file and one line here. Mobile's Metro reaches this
// file, so imports stay relative.

import { CHANGES_ANSWERS } from "./changes";
import { CODE_PART } from "./code";
import { DOCS_PART } from "./docs";
import { PAGES_PART } from "./pages";
import { RECALL_PART } from "./recall";
import { SEARCH_PART } from "./search";
import { DECISIONS_PART } from "./decisions";
import { MESSAGING_PART } from "./messaging";
import { FORKS_PART } from "./forks";
import { CALLS_PART } from "./calls";
import { CHAT_EXTRAS_PART } from "./chatExtras";
import { EXTRA_ANSWERS, seedAcmeExtras } from "./extras";
import { INBOX_PART } from "./inbox";
import { MACHINES_PART } from "./machines";
import { MACHINE_SESSIONS_PART } from "./machineSessions";
import { PLAN_ANSWERS } from "./plans";
import { PULL_REQUESTS_PART } from "./pullRequests";
import { TRIGGERS_PART } from "./triggers";
import { RETRIES_PLAN_PART } from "./retriesPlan";
import { WORKFLOWS_PART } from "./workflows";
import { SHARING_ANSWERS } from "./sharing";
import { TEAM_ACTIVITY_PART } from "./teamActivity";
import { CONVERSATIONS_PART } from "./conversations";

export type AcmePart = {
  name: string;
  /** Inbox rows (built with world.ts `session()`), re-stamped with the core sessions. */
  sessions?: (now: number) => Record<string, any>[];
  /** Store writes, after the core world is in. `s` is the store state. */
  seed?: (s: any, now: number) => void;
  /** Query answers by "module:function". */
  answers?: Record<string, (args: any) => unknown>;
};

export const ACME_PARTS: AcmePart[] = [
  { name: "changes", answers: CHANGES_ANSWERS },
  { name: "plans", answers: PLAN_ANSWERS },
  { name: "extras", seed: seedAcmeExtras, answers: EXTRA_ANSWERS },
  INBOX_PART,
  DECISIONS_PART,
  MESSAGING_PART,
  FORKS_PART,
  CALLS_PART,
  CHAT_EXTRAS_PART,
  MACHINES_PART,
  MACHINE_SESSIONS_PART,
  PULL_REQUESTS_PART,
  TRIGGERS_PART,
  RETRIES_PLAN_PART,
  WORKFLOWS_PART,
  { name: "sharing", answers: SHARING_ANSWERS },
  TEAM_ACTIVITY_PART,
  CONVERSATIONS_PART,
  SEARCH_PART,
  RECALL_PART,
  DOCS_PART,
  PAGES_PART,
  CODE_PART,
];
