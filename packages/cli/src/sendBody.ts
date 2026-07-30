/**
 * Stdin supplied to `cast send <session> -` has one newline added by the
 * transport (for example, the newline immediately before a heredoc delimiter).
 * Remove only that one newline. Any earlier newline is message content.
 */
export function removeStdinTransportNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export function prepareSessionSendBody(text: string, fromStdin: boolean): string {
  return fromStdin ? removeStdinTransportNewline(text) : text;
}
