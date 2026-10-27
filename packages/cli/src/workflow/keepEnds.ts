// A long station output cut to fit, keeping both ends: its start says what
// ran, and its end what came of it (a failing script prints its reason last).
// The middle gives way, and the marker says how much went.
export function keepEnds(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = (cut: number) => `\n… ${cut} characters cut …\n`;
  const room = cap - marker(text.length).length;
  if (room <= 0) return text.slice(0, cap);
  const head = Math.floor(room / 4);
  const tail = room - head;
  return text.slice(0, head) + marker(text.length - head - tail) + text.slice(text.length - tail);
}
