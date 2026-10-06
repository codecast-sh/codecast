// The finding line grammar a line reviewer writes in `cast task verdict --note`
// (templates/line/review.md). One finding per line:
//
//   <severity> <file>:<line>[-<end>] <what fails>[ -> <disposition>[ owner=<@role|user> due=<date>]]
//
// severity is one of blocker, high, medium, low, nit. Any line that does not
// parse is free text and stays in the verdict note as before; the findings
// become review_comments rows on the task, and a deferred one is a promise
// (owner and due are refused server-side when missing).

export const FINDING_SEVERITIES = ["blocker", "high", "medium", "low", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingDisposition = "fixed" | "deferred" | "rejected";

export interface Finding {
  severity: FindingSeverity;
  file_path: string;
  line_number?: number;
  line_end?: number;
  content: string;
  disposition?: FindingDisposition;
  owner?: string;
  due_at?: number;
}

const LINE_RE = new RegExp(`^(${FINDING_SEVERITIES.join("|")})\\s+(\\S+?)(?::(\\d+)(?:-(\\d+))?)?\\s+(.+)$`, "i");
const TAIL_RE = /\s+->\s+(fixed|deferred|rejected)((?:\s+(?:owner|due)=\S+)*)\s*$/i;

/** A due date: an ISO day, or a relative window (7d, 2w) from `now`. */
export function parseDue(text: string, now = Date.now()): number | undefined {
  const rel = /^(\d+)([dw])$/i.exec(text);
  if (rel) return now + Number(rel[1]) * (rel[2].toLowerCase() === "w" ? 7 : 1) * 86_400_000;
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : t;
}

export function parseFindingLine(line: string, now = Date.now()): Finding | null {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  let content = m[5].trim();
  const finding: Finding = { severity: m[1].toLowerCase() as FindingSeverity, file_path: m[2], content };
  if (m[3]) finding.line_number = Number(m[3]);
  if (m[4]) finding.line_end = Number(m[4]);
  const tail = TAIL_RE.exec(content);
  if (tail) {
    finding.disposition = tail[1].toLowerCase() as FindingDisposition;
    for (const kv of tail[2].trim().split(/\s+/).filter(Boolean)) {
      const [k, val] = kv.split("=", 2);
      if (k === "owner") finding.owner = val;
      if (k === "due") finding.due_at = parseDue(val, now);
    }
    finding.content = content.slice(0, tail.index).trim();
  }
  return finding;
}

/** Split a verdict note into its findings and the free text around them. */
export function parseFindings(note: string | undefined, now = Date.now()): { findings: Finding[]; text: string } {
  const findings: Finding[] = [];
  const text: string[] = [];
  for (const line of (note ?? "").split("\n")) {
    const f = parseFindingLine(line, now);
    if (f) findings.push(f);
    else text.push(line);
  }
  return { findings, text: text.join("\n").trim() };
}
