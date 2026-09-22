// Claude Code draws compaction as terminal chrome: a status line, a block
// bar with a percent, and sometimes a tip under it. The conversation should
// read that pattern and paint a progress row instead of the raw glyphs.
// Codex prints only the status line ("Compacting conversation (2m 10s • esc
// to interrupt)"), so a bar and a tip are optional.

export type CompactionProgress = {
  /** Elapsed text Claude printed, e.g. "33s" or "2m 10s". */
  elapsed: string | null;
  /** 0–100 when a bar line was present. */
  percent: number | null;
  /** Tip body, without the "Tip:" label. */
  tip: string | null;
};

const ANSI = /\x1b\[[0-9;]*m/g;
// Spinner frames, bullets, and the tree glyph in front of a tip.
const LEAD = /^[\s\u2800-\u28FF•·∙▪▸❯›>└⎿╰┌│*]+/;
const HEADER = /^compacting conversation(?:\.{1,3}|…)?(?:\s*\(([^)]*)\))?\s*$/i;
const BAR_BODY = /[\u2580-\u259F━─═=#]/;
const BAR_LINE = /^([\u2580-\u259F━─═=#\s.-]*?)\s*(\d{1,3})\s*%$/;
const TIP_LINE = /^tip:\s*(.+)$/i;

function visible(line: string): string {
  return line.replace(ANSI, "").replace(/\r/g, "").trim();
}

function core(line: string): string {
  return visible(line).replace(LEAD, "").trim();
}

function elapsedOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const cut = raw.split(/\s*[•·|]\s*|\s+esc\b/i)[0]?.trim() ?? "";
  return cut || null;
}

/** The compaction block inside `text`, or null when the text is not that screen. */
export function parseCompactionProgress(text: string | null | undefined): CompactionProgress | null {
  if (!text) return null;
  const lines = text.split("\n").map(visible).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const header = core(lines[i]).match(HEADER);
    if (!header) continue;
    // A sentence that merely mentions the words is not the status line.
    if (core(lines[i]).length > 80) continue;
    let percent: number | null = null;
    let tip: string | null = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const body = core(lines[j]);
      if (percent == null) {
        const bar = visible(lines[j]).match(BAR_LINE);
        const glyphs = bar?.[1]?.match(new RegExp(BAR_BODY.source, "g"))?.length ?? 0;
        if (bar && glyphs >= 3) {
          const n = Number(bar[2]);
          if (n >= 0 && n <= 100) percent = n;
          continue;
        }
      }
      const tipMatch = body.match(TIP_LINE);
      if (tipMatch) {
        tip = tipMatch[1].trim();
        break;
      }
      // Stop at the next prompt or a line that is neither the bar nor the tip.
      if (/^[❯›>]/.test(visible(lines[j])) || body.length > 0) break;
    }
    return { elapsed: elapsedOf(header[1]), percent, tip };
  }
  return null;
}

function isChromeLine(line: string): boolean {
  const shown = visible(line);
  if (!shown) return true;
  if (/^[❯›>]\s*\S/.test(shown) && shown.length < 80) return true;
  const body = core(line);
  if (HEADER.test(body)) return true;
  if (TIP_LINE.test(body)) return true;
  const bar = shown.match(BAR_LINE);
  const glyphs = bar?.[1]?.match(new RegExp(BAR_BODY.source, "g"))?.length ?? 0;
  return !!bar && glyphs >= 3;
}

/**
 * The progress when `text` is that screen and nothing else (a stored message
 * that captured the chrome). A transcript that only mentions compaction in
 * passing returns null.
 */
export function compactionProgressMessage(text: string | null | undefined): CompactionProgress | null {
  const progress = parseCompactionProgress(text);
  if (!progress || !text) return null;
  const leftover = text.split("\n").map(visible).filter(Boolean).filter((line) => !isChromeLine(line));
  return leftover.length === 0 ? progress : null;
}
