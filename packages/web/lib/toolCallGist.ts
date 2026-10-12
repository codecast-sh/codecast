// The one input that says what a tool call did (the file, url or command), on
// one line: read by a review quote and a line step's tool log.

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

export function toolCallGist(input: unknown, max = 80): string {
  let args: Record<string, unknown> | null = null;
  try {
    args = typeof input === "string" ? JSON.parse(input) : (input as Record<string, unknown>);
  } catch {
    return clip(String(input ?? ""), max);
  }
  const value = args && ["file_path", "path", "url", "command", "pattern", "query", "description"].map((k) => args![k]).find((v) => typeof v === "string");
  return value ? clip((value as string).split("\n")[0], max) : "";
}
