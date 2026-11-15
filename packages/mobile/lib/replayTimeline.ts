// A replay's stored text timeline (shared/replay/timeline.ts renderTimeline,
// cached on the row as timeline_md) read back into rows the phone draws: one
// per moment, on the replay's clock, with its kind. Pure, so it is testable.
import { currentTimelineText } from '@codecast/shared/replay';

export type TimelineKind = 'nav' | 'click' | 'input' | 'key' | 'scroll' | 'view' | 'error' | 'request' | 'warn' | 'mark' | 'gap' | 'other';

export type TimelineRow = {
  /** Ms on the replay clock; null for a "lines not shown" marker. */
  t: number | null;
  kind: TimelineKind;
  text: string;
  /** Stack or detail lines under a failure. */
  detail: string[];
};

/** "1:23.4" or "1:02:03.4" in ms; null for anything else. */
export function parseTimelineClock(s: string): number | null {
  const m = /^(?:(\d+):)?(\d+):(\d{2})(?:\.(\d))?$/.exec(s);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4] ?? 0) * 100;
}

function classify(text: string): { kind: TimelineKind; text: string } {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
  if (bold) {
    const head = bold[1];
    const rest = bold[2];
    if (head.startsWith('ERROR ')) return { kind: 'error', text: head.slice(6) + (rest ? ` ${rest}` : '') };
    if (head.startsWith('console.error')) return { kind: 'error', text: rest || head };
    return { kind: 'request', text: head + (rest ? ` ${rest}` : '') };
  }
  const word = text.split(/[\s:]/, 1)[0];
  switch (word) {
    case 'nav': return { kind: 'nav', text: text.slice(4) };
    case 'click': return { kind: 'click', text: text.slice(6) };
    case 'type':
    case 'focus':
    case 'submit': return { kind: 'input', text };
    case 'key': return { kind: 'key', text };
    case 'scroll': return { kind: 'scroll', text };
    case 'view': return { kind: 'view', text: text.replace(/^view:\s*/, '') };
    case 'console.warn': return { kind: 'warn', text: text.replace(/^console\.warn(?: x\d+)?\s*/, '') };
    case 'slow': return { kind: 'request', text };
    case 'mark': return { kind: 'mark', text: text.slice(5) };
    default: return { kind: 'other', text };
  }
}

/** The rows of a timeline_md, in order. Its heading line and blank lines are dropped. */
export function parseReplayTimeline(md: string | null | undefined): TimelineRow[] {
  if (!md) return [];
  const rows: TimelineRow[] = [];
  for (const raw of currentTimelineText(md).split('\n')) {
    if (/^\s{2,}\S/.test(raw) && rows.length) {
      rows[rows.length - 1].detail.push(raw.trim());
      continue;
    }
    const m = /^- (\S+) (.*)$/.exec(raw);
    if (!m) continue;
    if (m[1] === '…') {
      rows.push({ t: null, kind: 'gap', text: `… ${m[2]}`, detail: [] });
      continue;
    }
    const t = parseTimelineClock(m[1]);
    if (t === null) continue;
    rows.push({ t, ...classify(m[2]), detail: [] });
  }
  return rows;
}

/** The index of the row a moment falls on: the last one at or before it. -1 when none. */
export function rowAt(rows: readonly TimelineRow[], t: number): number {
  let at = -1;
  for (let i = 0; i < rows.length; i++) {
    const rt = rows[i].t;
    if (rt === null) continue;
    if (rt <= t) at = i;
    else break;
  }
  return at;
}
