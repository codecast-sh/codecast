export interface PermissionPrompt {
  tool_name: string;
  arguments_preview: string;
}

const PERMISSION_PATTERNS = [
  /Allow tool (\w+)\?\s*\[y\/n\]/i,
  /Permission required.*?to use (\w+)/i,
  /Do you want to allow.*?(\w+)/i,
  /Approve (\w+) tool/i,
  /Allow (\w+) to execute/i,
  /\[y\/n\]\s*$/i,
  /Allow execution\?/i,
  /Proceed with execution\?/i,
];

export function detectPermissionPrompt(content: string): PermissionPrompt | null {
  const hasYesNoPrompt = content.match(/\[y\/n\]\s*$/i);
  const hasAllowKeyword = content.match(/allow|permission|approve|proceed/i);

  if (hasYesNoPrompt && hasAllowKeyword) {
    const toolName = extractToolName(content);
    const argumentsPreview = extractArgumentsPreview(content);
    return {
      tool_name: toolName,
      arguments_preview: argumentsPreview,
    };
  }

  for (const pattern of PERMISSION_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const toolName = extractToolName(content);
      const argumentsPreview = extractArgumentsPreview(content);
      return {
        tool_name: toolName,
        arguments_preview: argumentsPreview,
      };
    }
  }

  return null;
}

function extractToolName(content: string): string {
  const lowerContent = content.toLowerCase();

  if (lowerContent.includes('bash') || lowerContent.includes('shell') || lowerContent.includes('command')) {
    return 'Bash';
  }
  if (lowerContent.includes('write') || lowerContent.includes('edit')) {
    return 'Edit';
  }
  if (lowerContent.includes('read')) {
    return 'Read';
  }

  const toolPatterns = [
    /(?:tool|allow)\s+['"]?(\w+)['"]?\s+(?:tool)?/i,
  ];

  for (const pattern of toolPatterns) {
    const match = content.match(pattern);
    if (match && match[1] && !match[1].match(/^(to|the|a|an)$/i)) {
      return match[1];
    }
  }

  return 'unknown';
}

function extractArgumentsPreview(content: string): string {
  const lines = content.split('\n');
  const relevantLines: string[] = [];

  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    if (line && !line.match(/^Allow|^Permission|^Do you want|^\[y\/n\]/i)) {
      relevantLines.push(line);
    }
  }

  const preview = relevantLines.join(' ').substring(0, 200);
  return preview || content.substring(0, 200);
}
