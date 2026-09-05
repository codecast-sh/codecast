import { extractSendBody, tokenizeShellArgs } from "./castCommand";

export function parseSessionUpdateSend(args: string, output: string) {
  const tokens = tokenizeShellArgs(args);
  let update = false;
  let bodyToken: typeof tokens[number] | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.quoted && !token.dynamic) {
      if (token.value === "--") {
        bodyToken ??= tokens[i + 1];
        break;
      }
      if (token.value === "--update") { update = true; continue; }
      if (token.value === "--from" || token.value === "--request-id") { i++; continue; }
      if (token.value === "--raw" || /^--(?:from|request-id)=/.test(token.value)) continue;
    }
    bodyToken ??= token;
  }
  if (!update) return null;
  const heredoc = args.indexOf("<<");
  const message = bodyToken?.value === "-" && heredoc >= 0
    ? extractSendBody(`- ${args.slice(heredoc)}`)
    : !bodyToken || bodyToken.dynamic || bodyToken.value === "-"
    ? { body: args, kind: "dynamic" as const }
    : { body: bodyToken.value, kind: "literal" as const };
  const receipt = output.replace(/\x1b\[[0-9;]*m/g, "").match(/^(QUEUED|ENQUEUED|CANCELLED|REJECTED) ([a-zA-Z0-9:_-]+) to [a-zA-Z0-9:_-]+(?:\s|$)/m);
  return { ...message, status: receipt ? receipt[1].toLowerCase() : "acceptance unconfirmed", updateId: receipt?.[2] };
}
