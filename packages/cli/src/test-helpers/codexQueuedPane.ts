export function codexQueuedPane(composer = "Ask Codex to do anything", queued = ["<session-message from=\"worker\">", "Read the saved checkpoint and continue the allocated work.", "</session-message>"]): string {
  return [
    "• Working (3m 16s • esc to interrupt)",
    "",
    "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
    ...queued.map((line, index) => `  ${index === 0 ? "↳ " : "  "}${line}`),
    "    …",
    "",
    `› ${composer}`,
    "",
    "  gpt-6-astra xhigh · /tmp/codecast-test-scratch",
  ].join("\n");
}
