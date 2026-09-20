export interface SessionHandoffPrompt {
  sourceId: string;
  sourceTitle: string;
  sourceAgent: string;
  brief: string;
  readMore: string;
  direction: string | null;
}

export function parseSessionHandoff(content: string): SessionHandoffPrompt | null {
  const text = content.trim().replace(/\r\n/g, "\n");
  const header = text.match(/^# Handed off from ([\w-]+): ([^\n]+)\n\nRan on ([^\n]+)\.\n\nThis session continues that work\./);
  if (!header) return null;

  const headings: Array<{ name: string; start: number; end: number }> = [];
  let offset = 0;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && line.slice(marker[0].length).trim() === "") fence = null;
    } else if (!fence && /^## (Brief|Read more|Direction)$/.test(line)) {
      headings.push({ name: line.slice(3), start: offset, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  const briefHeading = headings.find(h => h.name === "Brief");
  const readHeading = headings.find(h => h.name === "Read more" && h.start > (briefHeading?.end ?? Infinity) && text.slice(h.end).trimStart().startsWith("The source transcript has "));
  if (!briefHeading || !readHeading) return null;
  const directionHeading = headings.find(h => h.name === "Direction" && h.start > readHeading.end);
  const brief = text.slice(briefHeading.end, readHeading.start).trim();
  const readMore = text.slice(readHeading.end, directionHeading?.start).trim();
  if (!brief || !readMore.includes(`cast read ${header[1]} `)) return null;
  return {
    sourceId: header[1],
    sourceTitle: header[2].trim(),
    sourceAgent: header[3],
    brief,
    readMore,
    direction: directionHeading ? text.slice(directionHeading.end).trim() || null : null,
  };
}
