const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9-]{20,}/g,
  /api[_-]?key[=:]\s*["']?[a-zA-Z0-9_-]{20,}["']?/gi,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /[a-zA-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD)[a-zA-Z_]*[=:]\s*["']?[^\s"']{8,}["']?/gi,
];

export function redactSecrets(content: string): string {
  let result = content;
  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function containsSecrets(content: string): boolean {
  return API_KEY_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}
