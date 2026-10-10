// What a People chart card says, block by block, and how tall each block is.
// Pure, and the ONE place a card's height is decided: the layout books a card
// at the height this returns, and the card draws each block in a box of the
// height this gives it, clamped to the lines it was booked for. So a card can
// never be taller than its slot, and a long title or state line wraps instead
// of being cut at a few characters.
//
// Line counts are estimates from character counts (the app's mono face is
// 0.6em wide; the serif titles a little narrower), rounded toward more lines:
// a card may keep a sliver of air, it never overlaps the next.
import type { OrgRole, OrgSession } from "./orgTypes";
import { roleWords } from "./orgStaffingTypes";
import { standingLineOf } from "./orgMeta";
import { seatSentence, type OrgRoleSeat } from "@codecast/shared/contracts/orgProposal";

export const CARD = {
  role: { w: 360, far: 84 },
  person: { w: 300 },
  session: { w: 340, far: 50, min: 50 },
  cluster: { w: 340 },
  /** Frame chrome: a role's 3px top rule and 1px bottom border, its 12px/10px padding. */
  rolePad: 26,
  /** A role's title: serif 14px on 18px lines, two at most, beside its 30px face. */
  roleTitleChars: 27,
  roleTitleLine: 18,
  roleTitleMax: 2,
  roleHeaderMin: 32,
  /** The meta line under a role's title (persona, seat, sessions): 10.5px on 16px lines. */
  metaChars: 50,
  metaLine: 16,
  metaMax: 2,
  /** What the standing agent is doing now, in full: three lines, more when the card is open. */
  standingChars: 48,
  standingLine: 15,
  standingMax: 3,
  standingOpenMax: 8,
  /** The charter: its first paragraph, all of it when the card is open (10px on 14px lines). */
  charterChars: 52,
  charterLine: 14,
  charterMax: 8,
  charterOpenMax: 30,
  /** Rows every role card carries: its area's chips, its state bar and counts, its open work. */
  chipsRow: 26,
  stateRow: 24,
  workRow: 17,
  tenureRow: 18,
  /** A ghost seat's sentence (R2). */
  seatChars: 54,
  seatLine: 14,
  /** A change on the card, as a line. */
  changeLine: 20,
  changeMax: 3,
  /** Working sessions listed on a closed card. */
  runningLine: 15,
  runningMax: 3,
  /** An open card's sections: a heading and one row per item. */
  sectionGap: 8,
  sectionHead: 16,
  sectionRow: 16,
  openTasksMax: 5,
  openSessionsMax: 6,
  /** A session: 6px padding top and bottom and its 1px border. */
  sessionPad: 14,
  sessionTitleChars: 26,
  sessionTitleLine: 17,
  sessionTitleMax: 2,
  sessionTitleOpenMax: 4,
  /** The state · id · branch row under a session's title, with the 2px over it. */
  sessionMetaRow: 15,
  sessionHeaderMin: 36,
  /** Where the session stands: three lines, more when open. */
  detailChars: 46,
  detailLine: 14,
  detailGap: 4,
  detailMax: 3,
  detailOpenMax: 12,
  taskRow: 17,
  /** An open session's latest messages: each up to four lines. */
  messagesMax: 3,
  messageMax: 4,
} as const;

/** How many lines a text takes wrapped by word at `chars` a line, from one up to `max`.
 *  Each line break in the text starts a new line. */
export function wrapLines(text: string, chars: number, max: number): number {
  let total = 0;
  for (const para of text.split("\n")) {
    let lines = 1, used = 0;
    for (const word of para.trim().split(/\s+/).filter(Boolean)) {
      const need = used ? used + 1 + word.length : word.length;
      if (used && need > chars) { lines += 1; used = word.length; } else used = need;
      // A word longer than a line breaks inside itself.
      while (used > chars) { lines += 1; used -= chars; }
    }
    total += lines;
    if (total >= max) return max;
  }
  return Math.max(1, Math.min(max, total));
}

const stripHeading = (l: string) => l.replace(/^#+\s*/, "").trim();
/** A role's charter as the card prints it: the first paragraph (closed) or all of it (open), heading marks dropped. */
export function charterText(charter: string | undefined, open: boolean): string | null {
  const text = charter?.trim();
  if (!text) return null;
  const paras = text.split(/\n\s*\n/).map((p) => p.split("\n").map(stripHeading).filter(Boolean).join(" ")).filter(Boolean);
  if (!paras.length) return null;
  return open ? paras.join("\n") : paras[0];
}

/** A role's line under its title: its persona name, whether its seat is started, its sessions. */
export const roleMetaLine = (r: OrgRole, ghost?: boolean): string =>
  [roleWords(r).name, r.status === "paused" ? "paused" : null, ...(ghost ? [] : [r.standing ? "started" : "not started", r.total > 0 ? `${r.total} session${r.total === 1 ? "" : "s"}` : null])].filter(Boolean).join(" · ");

/** The standing agent's line as the card prints it: its status word, then what it says. */
export function standingText(r: Pick<OrgRole, "standing">): { label: string; color: string; text: string | null } | null {
  const line = standingLineOf(r.standing);
  return line ? { label: line.label, color: line.color, text: line.text } : null;
}

/** The changes a card lists as lines: one each up to the cap, then one more for the rest. */
export const changeLines = (n: number) => (n <= CARD.changeMax ? n : CARD.changeMax + 1);

/** The sessions a closed card lists: the ones working now, newest first, three at most. */
export const runningSessions = (holder: { sessions: OrgSession[] }): OrgSession[] => holder.sessions.filter((x) => x.state === "working").slice(0, CARD.runningMax);

export const seatHeight = (seat: OrgRoleSeat | undefined): number => (seat ? 6 + Math.ceil(seatSentence(seat).length / CARD.seatChars) * CARD.seatLine : 0);

/** What an open role card lists, read from the store (useOrgPeopleView). */
export type RoleOpenDetail = {
  /** Projects the role leads (shared projectLeadOf). */
  leads: { id: string; title: string; short_id?: string }[];
  /** Open tasks in its area, newest first. */
  tasks: { id: string; short_id: string; title: string; status: string }[];
};

export type RoleCardRows = {
  header: number; titleLines: number;
  meta: number; metaLines: number;
  tenure: number; seat: number;
  standing: number; standingLines: number;
  chips: number; state: number;
  changes: number;
  charter: number; charterLines: number; charterText: string | null;
  work: number; running: number;
  leads: number; tasks: number; sessions: number;
  h: number;
};

/** A role's full card, block by block. `open` is the in-place detail when the card is opened. */
export function roleCardRows(r: OrgRole, o: { ghost?: boolean; changes?: number; tenure?: boolean; seat?: OrgRoleSeat; open?: RoleOpenDetail | null }): RoleCardRows {
  const open = o.open ?? null;
  const ghost = !!o.ghost;
  const titleLines = wrapLines(roleWords(r).subtitle, CARD.roleTitleChars, CARD.roleTitleMax);
  const header = Math.max(CARD.roleHeaderMin, titleLines * CARD.roleTitleLine);
  const metaLines = wrapLines(roleMetaLine(r, ghost), CARD.metaChars, CARD.metaMax);
  const meta = 6 + metaLines * CARD.metaLine;
  const tenure = o.tenure ? CARD.tenureRow : 0;
  const seat = seatHeight(o.seat);
  const st = standingText(r);
  const standingLines = st ? wrapLines(`${st.label} · ${st.text ?? ""}`, CARD.standingChars, open ? CARD.standingOpenMax : CARD.standingMax) : 0;
  const standing = st ? 6 + standingLines * CARD.standingLine : 0;
  const chips = CARD.chipsRow;
  const state = ghost ? 0 : CARD.stateRow;
  const changes = o.changes ? 6 + changeLines(o.changes) * CARD.changeLine : 0;
  const text = charterText(r.charter, !!open);
  const charterLines = text ? wrapLines(text, CARD.charterChars, open ? CARD.charterOpenMax : CARD.charterMax) : 0;
  const charter = text ? 6 + charterLines * CARD.charterLine : 0;
  const work = ghost ? 0 : CARD.workRow;
  const n = runningSessions(r).length;
  const running = !open && n ? 6 + n * CARD.runningLine : 0;
  const section = (rows: number) => CARD.sectionGap + CARD.sectionHead + rows * CARD.sectionRow;
  const leads = open && !ghost ? section(open.leads.length) : 0;
  const tasks = open && !ghost ? section(Math.min(CARD.openTasksMax, open.tasks.length)) : 0;
  const sessions = open && !ghost ? section(Math.min(CARD.openSessionsMax, r.sessions.length)) : 0;
  const h = CARD.rolePad + header + meta + tenure + seat + standing + chips + state + changes + charter + work + running + leads + tasks + sessions;
  return { header, titleLines, meta, metaLines, tenure, seat, standing, standingLines, chips, state, changes, charter, charterLines, charterText: text, work, running, leads, tasks, sessions, h };
}

/** A session's close detail: where it stands, the task it is bound to and, for an open card, its latest messages. */
export type OrgSessionDetail = {
  line: string | null;
  task: { short_id: string; title: string } | null;
  /** The latest few messages the store has loaded, oldest first. */
  messages?: { who: string; text: string }[];
};

export type SessionCardRows = {
  header: number; titleLines: number;
  detail: number; detailLines: number;
  task: number;
  messages: { h: number; lines: number }[];
  h: number;
};

export function sessionCardRows(s: Pick<OrgSession, "title">, d: OrgSessionDetail | undefined, open: boolean): SessionCardRows {
  const titleLines = wrapLines(s.title || "Untitled", CARD.sessionTitleChars, open ? CARD.sessionTitleOpenMax : CARD.sessionTitleMax);
  const header = Math.max(CARD.sessionHeaderMin, titleLines * CARD.sessionTitleLine + CARD.sessionMetaRow);
  const detailLines = d?.line ? wrapLines(d.line, CARD.detailChars, open ? CARD.detailOpenMax : CARD.detailMax) : 0;
  const detail = detailLines ? CARD.detailGap + detailLines * CARD.detailLine : 0;
  const task = d?.task ? CARD.taskRow : 0;
  const messages = open ? (d?.messages ?? []).slice(-CARD.messagesMax).map((m) => { const lines = wrapLines(`${m.who}: ${m.text}`, CARD.detailChars, CARD.messageMax); return { lines, h: CARD.detailGap + lines * CARD.detailLine }; }) : [];
  const h = Math.max(CARD.session.min, CARD.sessionPad + header + detail + task + messages.reduce((a, m) => a + m.h, 0));
  return { header, titleLines, detail, detailLines, task, messages, h };
}

