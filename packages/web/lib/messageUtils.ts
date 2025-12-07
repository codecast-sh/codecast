export function isCommandMessage(content: string): boolean {
  const trimmed = content.trim();
  return /^<(command-name|command-message|local-command-stdout|local-command-stderr)>/.test(trimmed) ||
    trimmed.startsWith("Caveat:");
}

export function parseCommandMessage(content: string): { type: string; value: string } | null {
  const match = content.match(/<(command-name|command-message)>([^<]*)<\/\1>/);
  if (match) {
    return { type: match[1], value: match[2] };
  }
  if (content.includes("<local-command-stdout>")) {
    return { type: "command-output", value: "command output" };
  }
  if (content.includes("<local-command-stderr>")) {
    return { type: "command-error", value: "command error" };
  }
  if (content.trim().startsWith("Caveat:")) {
    return { type: "caveat", value: content.trim().slice(0, 80) + (content.length > 80 ? "..." : "") };
  }
  return null;
}

export function cleanMessageContent(content: string): string {
  if (!content) return "";

  let cleaned = content
    .replace(/<command-name>[^<]*<\/command-name>/g, "")
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "[output]")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "[error]")
    .replace(/<[^>]+>/g, "")
    .trim();

  if (cleaned.startsWith("Caveat:")) {
    return "";
  }

  return cleaned;
}

export function getMessagePreview(content: string, maxLength: number = 100): string {
  const cleaned = cleanMessageContent(content);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength) + "...";
}

export function getCommandLabel(content: string): { label: string; type: string } | null {
  const parsed = parseCommandMessage(content);
  if (!parsed) return null;

  const typeLabels: Record<string, string> = {
    "command-name": "cmd",
    "command-message": "msg",
    "command-output": "output",
    "command-error": "error",
    "caveat": "note",
  };

  return {
    label: typeLabels[parsed.type] || "status",
    type: parsed.type,
  };
}
