export function structuredMessageInput(content: string): string | null {
  const text = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  const input = fenced ? fenced[1].trim() : text;
  if (!input.startsWith("{") || !input.endsWith("}")) return null;
  try {
    const payload = JSON.parse(input);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? input : null;
  } catch {
    return null;
  }
}
